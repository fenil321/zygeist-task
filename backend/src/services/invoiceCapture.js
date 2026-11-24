import { GoogleGenAI, Type } from "@google/genai";
import Decimal from "decimal.js";
import dotenv from "dotenv";
import { pool } from "../db.js";
import { sendPriceChangeBatch } from "./priceSync.js";

dotenv.config();
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function generateWithRetry(params, maxRounds = 3) {
  const baseModels = [
    process.env.GEMINI_MODEL,
    process.env.GEMINI_FALLBACK_MODEL,
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
  ].filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx);

  const blockedModels = new Set();
  let lastError = null;

  for (let round = 1; round <= maxRounds; round++) {
    for (const currentModel of baseModels) {
      if (blockedModels.has(currentModel)) continue;
      try {
        return await ai.models.generateContent({
          ...params,
          model: currentModel,
        });
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err);
        const isNotFound =
          err?.status === 404 ||
          msg.includes("404") ||
          msg.includes("NOT_FOUND");
        const isQuotaBlocked =
          msg.includes("limit: 0") ||
          msg.includes("exceeded your current quota");
        const isTransient =
          err?.status === 503 ||
          err?.status === 429 ||
          msg.includes("503") ||
          msg.includes("429") ||
          msg.includes("UNAVAILABLE") ||
          msg.includes("RESOURCE_EXHAUSTED") ||
          msg.includes("high demand");

        if (isNotFound || isQuotaBlocked) {
          blockedModels.add(currentModel);
          console.warn(
            `[GEMINI SKIP] ${currentModel} disabled on current quota`,
          );
          continue;
        }

        if (!isTransient) throw err;

        const waitMs = 2000 * round + Math.floor(Math.random() * 800);
        console.warn(
          `[GEMINI ROTATE] ${currentModel} busy (round ${round}/${maxRounds}). Switching model in ${waitMs}ms...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  throw new Error(
    `Gemini extraction failed after ${maxRounds} rounds. Last error: ${lastError?.message || lastError}`,
  );
}
const INVOICE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    supplier_name: {
      type: Type.STRING,
      description: "Vendor or distributor name on invoice",
    },
    invoice_number: {
      type: Type.STRING,
      description: "Invoice ID or reference number",
    },
    invoice_date: {
      type: Type.STRING,
      description: "YYYY-MM-DD format if visible, else raw date",
    },
    due_date: { type: Type.STRING, nullable: true },
    currency: {
      type: Type.STRING,
      description: "3-letter currency code, default USD",
    },
    subtotal: {
      type: Type.STRING,
      description: "Exact numeric string with 2 decimals, e.g. 142.50",
    },
    tax_amount: {
      type: Type.STRING,
      description: "Exact numeric string with 2 decimals, 0.00 if none",
    },
    shipping_or_fees: {
      type: Type.STRING,
      description: "Exact numeric string with 2 decimals, 0.00 if none",
    },
    total_amount: {
      type: Type.STRING,
      description: "Grand total numeric string with 2 decimals",
    },
    extraction_notes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Any handwritten annotations, smudges, damaged-item credits, or low-confidence readings",
    },
    line_items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          line_no: { type: Type.INTEGER },
          supplier_sku: { type: Type.STRING, nullable: true },
          description: { type: Type.STRING },
          quantity: {
            type: Type.STRING,
            description: "Numeric string, e.g. 12 or 2.5",
          },
          unit_of_measure: {
            type: Type.STRING,
            description: "CASE, EA, LB, BOX, etc.",
          },
          units_per_case: {
            type: Type.INTEGER,
            description: "1 unless pack size like 12x16oz is stated",
          },
          unit_cost: {
            type: Type.STRING,
            description: "Unit price as printed on invoice, 2 decimals",
          },
          line_total: {
            type: Type.STRING,
            description:
              "Extended line total as printed on invoice, 2 decimals",
          },
          confidence: {
            type: Type.NUMBER,
            description: "0.0 to 1.0 extraction confidence",
          },
        },
        required: [
          "line_no",
          "description",
          "quantity",
          "unit_cost",
          "line_total",
          "confidence",
        ],
      },
    },
  },
  required: [
    "supplier_name",
    "invoice_number",
    "invoice_date",
    "subtotal",
    "tax_amount",
    "shipping_or_fees",
    "total_amount",
    "line_items",
    "extraction_notes",
  ],
};

let tablesReady = false;
async function ensureInvoiceTables() {
  if (tablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id SERIAL PRIMARY KEY,
      store_id VARCHAR(16) NOT NULL,
      source_filename VARCHAR(255) NOT NULL,
      mime_type VARCHAR(64),
      supplier_name VARCHAR(128),
      invoice_number VARCHAR(64),
      invoice_date VARCHAR(32),
      subtotal NUMERIC(12,2) DEFAULT 0,
      tax_amount NUMERIC(12,2) DEFAULT 0,
      shipping_or_fees NUMERIC(12,2) DEFAULT 0,
      total_amount NUMERIC(12,2) DEFAULT 0,
      math_valid BOOLEAN DEFAULT TRUE,
      discrepancies JSONB DEFAULT '[]'::jsonb,
      extraction_notes JSONB DEFAULT '[]'::jsonb,
      status VARCHAR(32) DEFAULT 'PENDING_REVIEW',
      price_change_id VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      supplier_sku VARCHAR(64),
      description TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL,
      unit_of_measure VARCHAR(24) DEFAULT 'EA',
      units_per_case INTEGER DEFAULT 1,
      unit_cost NUMERIC(12,2) NOT NULL,
      line_total NUMERIC(12,2) NOT NULL,
      expected_line_total NUMERIC(12,2) NOT NULL,
      math_mismatch BOOLEAN DEFAULT FALSE,
      math_note TEXT,
      confidence NUMERIC(4,3) DEFAULT 0.95,
      matched_item_code VARCHAR(32),
      matched_variant VARCHAR(16) DEFAULT '000',
      matched_description VARCHAR(128),
      match_score NUMERIC(4,3) DEFAULT 0,
      suggested_action VARCHAR(16) DEFAULT 'update',
      proposed_dept_code VARCHAR(16) DEFAULT '10',
      proposed_tax_group VARCHAR(16) DEFAULT 'T1',
      current_retail_price NUMERIC(12,2),
      recommended_retail_price NUMERIC(12,2),
      approved_retail_price NUMERIC(12,2),
      include_in_sync BOOLEAN DEFAULT TRUE
    );
  `);
  tablesReady = true;
}

function safeDec(val, fallback = "0.00") {
  try {
    if (val === null || val === undefined || val === "")
      return new Decimal(fallback);
    const cleaned = String(val).replace(/[^0-9.-]/g, "");
    return cleaned ? new Decimal(cleaned) : new Decimal(fallback);
  } catch {
    return new Decimal(fallback);
  }
}

function computeRetailPrice(
  unitCostDec,
  unitsPerCase,
  targetMarginPct,
  endingDigit = 9,
) {
  const effectiveUnitCost =
    unitsPerCase > 1 ? unitCostDec.div(unitsPerCase) : unitCostDec;
  const marginFraction = new Decimal(targetMarginPct).div(100);
  const divisor = new Decimal(1).minus(marginFraction);
  const rawPrice = divisor.gt(0)
    ? effectiveUnitCost.div(divisor)
    : effectiveUnitCost.mul(new Decimal("1.35"));

  let rounded = rawPrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (endingDigit !== null && endingDigit !== undefined) {
    const cents = rounded.mul(100).toNumber();
    const baseTen = Math.floor(cents / 10) * 10;
    let candidate = (baseTen + Number(endingDigit)) / 100;
    if (candidate < effectiveUnitCost.toNumber()) candidate += 0.1;
    rounded = new Decimal(candidate).toDecimalPlaces(2);
  }
  return {
    effectiveUnitCost: effectiveUnitCost.toFixed(2),
    recommendedRetail: rounded.toFixed(2),
  };
}

function scoreCatalogMatch(line, catalogItems) {
  const lineSku = (line.supplier_sku || "").trim().toLowerCase();
  const lineTokens = new Set(
    line.description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );

  let best = null;
  let bestScore = 0;

  for (const item of catalogItems) {
    if (lineSku && item.item_code.toLowerCase() === lineSku) {
      return { item, score: 1.0 };
    }
    const itemTokens = item.description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (itemTokens.length === 0 || lineTokens.size === 0) continue;
    let overlap = 0;
    for (const tok of itemTokens) {
      if (lineTokens.has(tok)) overlap++;
    }
    const score = overlap / Math.max(lineTokens.size, itemTokens.length);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 0.45
    ? { item: best, score: Number(bestScore.toFixed(3)) }
    : { item: null, score: 0 };
}

export async function processSupplierInvoice({
  buffer,
  mimeType,
  filename,
  storeId = "BL01",
  targetMargin = 35,
  persist = true,
}) {
  await ensureInvoiceTables();

  const prompt = `You are a retail accounts-payable AI specialist for Brightleaf Market.
Extract every field and line item from this supplier invoice accurately.
Rules:
1. Transcribe printed numbers exactly as shown on the document—do NOT silently alter a printed line_total or total_amount even if the supplier made an arithmetic mistake.
2. Note any handwritten adjustments, crossed-out quantities, damaged-goods credits, or blurry text in extraction_notes.
3. If pack size is printed (e.g., "12x16oz" or "Case of 24"), set units_per_case accordingly; otherwise set units_per_case to 1.`;

  const response = await generateWithRetry({
    contents: [
      {
        inlineData: {
          data: buffer.toString("base64"),
          mimeType,
        },
      },
      prompt,
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: INVOICE_SCHEMA,
      temperature: 0.1,
    },
  });

  const extracted = JSON.parse(response.text);
  const catalogRes = await pool.query(
    "SELECT item_code, variant, description, dept_code, price, tax_group FROM items WHERE store_id = $1 AND is_active = TRUE",
    [storeId],
  );
  const catalogItems = catalogRes.rows;

  const discrepancies = [];
  let computedLinesSum = new Decimal("0.00");
  const enrichedLines = [];

  for (const rawLine of extracted.line_items || []) {
    const qty = safeDec(rawLine.quantity, "1");
    const unitCost = safeDec(rawLine.unit_cost, "0.00");
    const printedLineTotal = safeDec(rawLine.line_total, "0.00");
    const expectedLineTotal = qty
      .mul(unitCost)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const lineDiff = printedLineTotal.minus(expectedLineTotal).abs();
    const mathMismatch = lineDiff.gt(new Decimal("0.01"));

    computedLinesSum = computedLinesSum.plus(printedLineTotal);

    let mathNote = null;
    if (mathMismatch) {
      mathNote = `Line ${rawLine.line_no} (${rawLine.description}): ${qty.toString()} x $${unitCost.toFixed(2)} = $${expectedLineTotal.toFixed(2)}, but invoice states $${printedLineTotal.toFixed(2)} (diff $${lineDiff.toFixed(2)})`;
      discrepancies.push(mathNote);
    }

    const { item: matchedItem, score: matchScore } = scoreCatalogMatch(
      rawLine,
      catalogItems,
    );
    const unitsPerCase = Number(rawLine.units_per_case || 1);
    const { recommendedRetail } = computeRetailPrice(
      unitCost,
      unitsPerCase,
      targetMargin,
      9,
    );

    const cleanDesc = rawLine.description.trim().slice(0, 24);
    const generatedNewCode =
      rawLine.supplier_sku && /^\d{6,14}$/.test(rawLine.supplier_sku.trim())
        ? rawLine.supplier_sku.trim()
        : `20099${String(Math.floor(1000000 + Math.random() * 8999999))}`;

    enrichedLines.push({
      lineNo: rawLine.line_no,
      supplierSku: rawLine.supplier_sku || null,
      description: rawLine.description,
      cleanCatalogDesc: matchedItem ? matchedItem.description : cleanDesc,
      quantity: qty.toFixed(3),
      unitOfMeasure: rawLine.unit_of_measure || "EA",
      unitsPerCase,
      unitCost: unitCost.toFixed(2),
      lineTotal: printedLineTotal.toFixed(2),
      expectedLineTotal: expectedLineTotal.toFixed(2),
      mathMismatch,
      mathNote,
      confidence: rawLine.confidence ?? 0.9,
      matchedItemCode: matchedItem ? matchedItem.item_code : generatedNewCode,
      matchedVariant: matchedItem ? matchedItem.variant : "000",
      matchedDescription: matchedItem ? matchedItem.description : null,
      matchScore,
      suggestedAction: matchedItem ? "update" : "add",
      proposedDeptCode: matchedItem ? matchedItem.dept_code : "10",
      proposedTaxGroup: matchedItem ? matchedItem.tax_group : "T1",
      currentRetailPrice: matchedItem ? String(matchedItem.price) : null,
      recommendedRetailPrice: recommendedRetail,
      approvedRetailPrice: recommendedRetail,
      includeInSync: true,
    });
  }

  const printedSubtotal = safeDec(
    extracted.subtotal,
    computedLinesSum.toFixed(2),
  );
  const taxAmount = safeDec(extracted.tax_amount, "0.00");
  const feesAmount = safeDec(extracted.shipping_or_fees, "0.00");
  const printedGrandTotal = safeDec(extracted.total_amount, "0.00");
  const expectedGrandTotal = computedLinesSum
    .plus(taxAmount)
    .plus(feesAmount)
    .toDecimalPlaces(2);

  if (printedSubtotal.minus(computedLinesSum).abs().gt(new Decimal("0.01"))) {
    discrepancies.push(
      `Subtotal mismatch: sum of line totals is $${computedLinesSum.toFixed(2)}, but invoice subtotal states $${printedSubtotal.toFixed(2)}`,
    );
  }
  if (
    printedGrandTotal.minus(expectedGrandTotal).abs().gt(new Decimal("0.01"))
  ) {
    discrepancies.push(
      `Grand total mismatch: lines ($${computedLinesSum.toFixed(2)}) + tax ($${taxAmount.toFixed(2)}) + fees ($${feesAmount.toFixed(2)}) = $${expectedGrandTotal.toFixed(2)}, but invoice total states $${printedGrandTotal.toFixed(2)}`,
    );
  }

  const mathValid = discrepancies.length === 0;

  if (!persist) {
    return {
      supplierName: extracted.supplier_name,
      invoiceNumber: extracted.invoice_number,
      invoiceDate: extracted.invoice_date,
      subtotal: printedSubtotal.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      shippingOrFees: feesAmount.toFixed(2),
      totalAmount: printedGrandTotal.toFixed(2),
      computedTotalAmount: expectedGrandTotal.toFixed(2),
      mathValid,
      discrepancies,
      extractionNotes: extracted.extraction_notes || [],
      lines: enrichedLines,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invRes = await client.query(
      `INSERT INTO supplier_invoices
         (store_id, source_filename, mime_type, supplier_name, invoice_number, invoice_date,
          subtotal, tax_amount, shipping_or_fees, total_amount, math_valid, discrepancies, extraction_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        storeId,
        filename,
        mimeType,
        extracted.supplier_name,
        extracted.invoice_number,
        extracted.invoice_date,
        printedSubtotal.toFixed(2),
        taxAmount.toFixed(2),
        feesAmount.toFixed(2),
        printedGrandTotal.toFixed(2),
        mathValid,
        JSON.stringify(discrepancies),
        JSON.stringify(extracted.extraction_notes || []),
      ],
    );
    const invoice = invRes.rows[0];

    const savedLines = [];
    for (const l of enrichedLines) {
      const lineRes = await client.query(
        `INSERT INTO supplier_invoice_lines
           (invoice_id, line_no, supplier_sku, description, quantity, unit_of_measure, units_per_case,
            unit_cost, line_total, expected_line_total, math_mismatch, math_note, confidence,
            matched_item_code, matched_variant, matched_description, match_score, suggested_action,
            proposed_dept_code, proposed_tax_group, current_retail_price, recommended_retail_price,
            approved_retail_price, include_in_sync)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING *`,
        [
          invoice.id,
          l.lineNo,
          l.supplierSku,
          l.description,
          l.quantity,
          l.unitOfMeasure,
          l.unitsPerCase,
          l.unitCost,
          l.lineTotal,
          l.expectedLineTotal,
          l.mathMismatch,
          l.mathNote,
          l.confidence,
          l.matchedItemCode,
          l.matchedVariant,
          l.matchedDescription,
          l.matchScore,
          l.suggestedAction,
          l.proposedDeptCode,
          l.proposedTaxGroup,
          l.currentRetailPrice,
          l.recommendedRetailPrice,
          l.approvedRetailPrice,
          true,
        ],
      );
      savedLines.push(lineRes.rows[0]);
    }

    await client.query("COMMIT");
    return { invoice, lines: savedLines };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listSupplierInvoices() {
  await ensureInvoiceTables();
  const res = await pool.query(
    "SELECT * FROM supplier_invoices ORDER BY created_at DESC",
  );
  return res.rows;
}

export async function getSupplierInvoiceDetail(invoiceId) {
  await ensureInvoiceTables();
  const invRes = await pool.query(
    "SELECT * FROM supplier_invoices WHERE id = $1",
    [invoiceId],
  );
  if (invRes.rowCount === 0) return null;
  const linesRes = await pool.query(
    "SELECT * FROM supplier_invoice_lines WHERE invoice_id = $1 ORDER BY line_no",
    [invoiceId],
  );
  return { invoice: invRes.rows[0], lines: linesRes.rows };
}

export async function approveInvoiceAndPushPrices({
  invoiceId,
  linesOverride,
  inboxDir,
  pushToHub = true,
}) {
  await ensureInvoiceTables();
  const detail = await getSupplierInvoiceDetail(invoiceId);
  if (!detail) throw new Error(`Invoice ${invoiceId} not found`);

  const { invoice, lines } = detail;
  const overrideMap = new Map(
    (linesOverride || []).map((l) => [Number(l.id), l]),
  );

  const syncItems = [];
  for (const line of lines) {
    const ov = overrideMap.get(Number(line.id)) || {};
    const include =
      ov.include_in_sync !== undefined
        ? Boolean(ov.include_in_sync)
        : line.include_in_sync;
    const approvedPrice = ov.approved_retail_price
      ? new Decimal(ov.approved_retail_price).toFixed(2)
      : String(line.approved_retail_price || line.recommended_retail_price);
    const itemCode = ov.matched_item_code || line.matched_item_code;
    const variant = ov.matched_variant || line.matched_variant || "000";
    const action = ov.suggested_action || line.suggested_action || "update";
    const deptCode = ov.proposed_dept_code || line.proposed_dept_code || "10";
    const taxGroup = ov.proposed_tax_group || line.proposed_tax_group || "T1";
    const shortDesc = (
      ov.description ||
      line.matched_description ||
      line.description
    )
      .trim()
      .slice(0, 24);

    await pool.query(
      `UPDATE supplier_invoice_lines
       SET approved_retail_price = $1,
           matched_item_code = $2,
           matched_variant = $3,
           suggested_action = $4,
           proposed_dept_code = $5,
           proposed_tax_group = $6,
           include_in_sync = $7
       WHERE id = $8`,
      [
        approvedPrice,
        itemCode,
        variant,
        action,
        deptCode,
        taxGroup,
        include,
        line.id,
      ],
    );

    if (include && itemCode) {
      syncItems.push({
        action,
        itemCode,
        variant,
        description: action === "add" ? shortDesc : undefined,
        deptCode: action === "add" ? deptCode : undefined,
        taxGroup: action === "add" ? taxGroup : undefined,
        oldPrice: line.current_retail_price
          ? String(line.current_retail_price)
          : undefined,
        newPrice: approvedPrice,
      });
    }
  }

  let syncResult = null;
  const changeId = `INV-${invoice.store_id}-${invoice.id}-${Date.now().toString().slice(-4)}`;

  if (pushToHub && syncItems.length > 0) {
    syncResult = await sendPriceChangeBatch({
      storeId: invoice.store_id,
      changeId,
      items: syncItems,
      inboxDir,
    });
  }

  await pool.query(
    `UPDATE supplier_invoices
     SET status = 'APPROVED',
         price_change_id = $1,
         approved_at = NOW()
     WHERE id = $2`,
    [syncResult ? changeId : null, invoiceId],
  );

  return {
    invoiceId: Number(invoiceId),
    status: "APPROVED",
    changeId: syncResult ? changeId : null,
    pushedItemCount: syncItems.length,
    syncResult,
  };
}
