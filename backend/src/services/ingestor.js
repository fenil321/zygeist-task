import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { pool } from "../db.js";
import { parseV2Xml } from "../parsers/v2XmlParser.js";
import { parseV3Json } from "../parsers/v3JsonParser.js";

export async function ingestOutboxFile(filePath, onEventBroadcast = null) {
  const filename = path.basename(filePath);
  if (filename.endsWith(".tmp") || filename.startsWith(".")) return;

  let rawBuffer;
  try {
    rawBuffer = await fs.readFile(filePath);
  } catch (err) {
    // File may still be flushing; watcher will retry on next event
    return;
  }

  const sha256 = crypto.createHash("sha256").update(rawBuffer).digest("hex");
  const rawContent = rawBuffer.toString("utf8");

  const client = await pool.connect();
  let fatalDbErr = null;
  try {
    // 1. Idempotency check: skip if exact (filename + sha256) was already imported or quarantined
    const histCheck = await client.query(
      "SELECT 1 FROM import_history WHERE filename = $1 AND file_sha256 = $2",
      [filename, sha256],
    );
    if (histCheck.rowCount > 0) return;

    const quarCheck = await client.query(
      "SELECT 1 FROM quarantined_files WHERE filename = $1 AND file_sha256 = $2",
      [filename, sha256],
    );
    if (quarCheck.rowCount > 0) return;

    // 2. Parse based on file extension; quarantine any damaged/corrupted file
    let parsed;
    try {
      if (filename.endsWith(".json")) {
        parsed = parseV3Json(rawContent, filename);
      } else if (filename.endsWith(".xml")) {
        parsed = parseV2Xml(rawContent, filename);
      } else {
        throw new Error(`Unsupported file extension for ${filename}`);
      }
    } catch (parseErr) {
      await client.query(
        `INSERT INTO quarantined_files (store_id, filename, file_sha256, error_reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (filename, file_sha256) DO NOTHING`,
        [extractStoreHint(filename), filename, sha256, parseErr.message],
      );
      console.warn(`[QUARANTINED] ${filename}: ${parseErr.message}`);
      if (onEventBroadcast) {
        onEventBroadcast({
          type: "FILE_QUARANTINED",
          filename,
          reason: parseErr.message,
        });
      }
      return;
    }

    // 3. Persist normalized payload inside an atomic DB transaction
    await client.query("BEGIN");

    if (parsed.storeId) {
      await client.query(
        `INSERT INTO stores (store_id, name)
         VALUES ($1, $2)
         ON CONFLICT (store_id) DO NOTHING`,
        [parsed.storeId, `Brightleaf ${parsed.storeId}`],
      );
    }

    let accepted = 0;
    let duplicatesSkipped = 0;
    let rowsFlagged = 0;

    if (parsed.kind === "TLOG") {
      const res = await loadTlogBatch(client, parsed, filename);
      accepted = res.accepted;
      duplicatesSkipped = res.duplicatesSkipped;
      rowsFlagged = res.rowsFlagged;
    } else if (parsed.kind === "SHIFT") {
      await client.query(
        `INSERT INTO shift_summaries
           (store_id, business_date, shift_no, source_file, opening_float, counted_cash, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (store_id, business_date, shift_no) DO UPDATE SET
           source_file = EXCLUDED.source_file,
           opening_float = EXCLUDED.opening_float,
           counted_cash = EXCLUDED.counted_cash,
           raw_payload = EXCLUDED.raw_payload,
           imported_at = NOW()`,
        [
          parsed.storeId,
          parsed.businessDate,
          parsed.shiftNo,
          filename,
          parsed.openingFloat,
          parsed.countedCash,
          JSON.stringify(parsed.payload),
        ],
      );
      accepted = 1;
    } else if (parsed.kind === "EOD") {
      await client.query(
        `INSERT INTO eod_summaries
           (store_id, business_date, source_file, reported_tx_count, reported_net_sales,
            reported_tax, reported_gc_loads, reported_grand_total, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (store_id, business_date) DO UPDATE SET
           source_file = EXCLUDED.source_file,
           reported_tx_count = EXCLUDED.reported_tx_count,
           reported_net_sales = EXCLUDED.reported_net_sales,
           reported_tax = EXCLUDED.reported_tax,
           reported_gc_loads = EXCLUDED.reported_gc_loads,
           reported_grand_total = EXCLUDED.reported_grand_total,
           raw_payload = EXCLUDED.raw_payload,
           imported_at = NOW()`,
        [
          parsed.storeId,
          parsed.businessDate,
          filename,
          parsed.reportedTxCount,
          parsed.reportedNetSales,
          parsed.reportedTax,
          parsed.reportedGcLoads,
          parsed.reportedGrandTotal,
          JSON.stringify(parsed.payload),
        ],
      );
      accepted = 1;
    } else if (parsed.kind === "PRICELIST") {
      for (const d of parsed.departments) {
        if (d.deptCode) {
          await client.query(
            `INSERT INTO departments (dept_code, name)
             VALUES ($1, $2)
             ON CONFLICT (dept_code) DO UPDATE SET name = EXCLUDED.name`,
            [d.deptCode, d.name],
          );
        }
      }
      for (const item of parsed.items) {
        await client.query(
          `INSERT INTO items
             (store_id, item_code, variant, description, dept_code, price, tax_group, min_age, unit, containers, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
           ON CONFLICT (store_id, item_code, variant) DO UPDATE SET
             description = EXCLUDED.description,
             dept_code = EXCLUDED.dept_code,
             price = EXCLUDED.price,
             tax_group = EXCLUDED.tax_group,
             min_age = EXCLUDED.min_age,
             unit = EXCLUDED.unit,
             containers = EXCLUDED.containers,
             updated_at = NOW()`,
          [
            parsed.storeId,
            item.itemCode,
            item.variant,
            item.description,
            item.deptCode,
            item.price,
            item.taxGroup,
            item.minAge,
            item.unit,
            item.containers,
          ],
        );
        accepted++;
      }
    } else if (parsed.kind === "ACK") {
      await handleAckFile(client, parsed);
      accepted = parsed.items.length || 1;
    } else if (parsed.kind === "REJ") {
      await client.query(
        `UPDATE price_change_batches
         SET status = 'REJECTED', reject_reason = $1, acked_at = NOW()
         WHERE change_id = $2`,
        [`[${parsed.errorCode}] ${parsed.message}`, parsed.changeId],
      );
      await client.query(
        `UPDATE price_change_items
         SET status = 'REJECTED', error_code = $1, error_message = $2
         WHERE change_id = $3`,
        [parsed.errorCode, parsed.message, parsed.changeId],
      );
      accepted = 1;
    }

    // 4. Record import audit log
    await client.query(
      `INSERT INTO import_history
         (store_id, filename, file_sha256, file_format, records_accepted, duplicates_skipped, rows_flagged)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        parsed.storeId,
        filename,
        sha256,
        parsed.format,
        accepted,
        duplicatesSkipped,
        rowsFlagged,
      ],
    );

    await client.query("COMMIT");
    console.log(
      `[IMPORTED] ${filename} (${parsed.format}) -> accepted=${accepted}, dupes=${duplicatesSkipped}, flagged=${rowsFlagged}`,
    );

    if (onEventBroadcast) {
      onEventBroadcast({
        type: "FILE_IMPORTED",
        storeId: parsed.storeId,
        kind: parsed.kind,
        filename,
        accepted,
        duplicatesSkipped,
        rowsFlagged,
      });
    }
  } catch (err) {
    fatalDbErr = err;
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[ERROR] Failed processing ${filename}:`, err.message);
  } finally {
    // Passing an error tells pg-pool to discard a broken socket rather than reuse it
    client.release(fatalDbErr);
  }
}

// --- BULK-INSERT VERSION OF loadTlogBatch (4 queries per file instead of ~250) ---
async function loadTlogBatch(client, parsed, filename) {
  if (!parsed.transactions || parsed.transactions.length === 0) {
    return { accepted: 0, duplicatesSkipped: 0, rowsFlagged: 0 };
  }

  const devRes = await client.query(
    "SELECT device_id FROM devices WHERE store_id = $1",
    [parsed.storeId],
  );
  const knownDevices = new Set(devRes.rows.map((r) => r.device_id));

  const staffRes = await client.query("SELECT staff_id FROM staff");
  const knownStaff = new Set(staffRes.rows.map((r) => r.staff_id));

  const deptRes = await client.query("SELECT dept_code FROM departments");
  const knownDepts = new Set(deptRes.rows.map((r) => r.dept_code));

  const itemRes = await client.query(
    "SELECT item_code, variant FROM items WHERE store_id = $1",
    [parsed.storeId],
  );
  const knownItems = new Set(
    itemRes.rows.map((r) => `${r.item_code}:${r.variant}`),
  );

  const preparedTxs = parsed.transactions.map((tx) => {
    const reviewReasons = [];
    if (knownDevices.size > 0 && !knownDevices.has(tx.deviceId)) {
      reviewReasons.push(`Unknown device '${tx.deviceId}'`);
    }
    if (
      knownStaff.size > 0 &&
      tx.staffId !== "0" &&
      !knownStaff.has(tx.staffId)
    ) {
      reviewReasons.push(`Unknown staff '${tx.staffId}'`);
    }

    const lineFlags = tx.lines.map((line) => {
      const reasons = [];
      if (line.lineType === "ITEM") {
        if (
          line.deptCode &&
          knownDepts.size > 0 &&
          !knownDepts.has(line.deptCode)
        ) {
          reasons.push(`Unknown department '${line.deptCode}'`);
        }
        if (line.itemCode && knownItems.size > 0) {
          const key = `${line.itemCode}:${line.variant || "000"}`;
          if (!knownItems.has(key)) {
            reasons.push(`Unknown item '${key}'`);
          }
        }
      }
      return reasons;
    });

    lineFlags.forEach((r) => reviewReasons.push(...r));
    const uniqueReasons = [...new Set(reviewReasons)];
    return {
      ...tx,
      lineFlags,
      uniqueReasons,
      needsReview: uniqueReasons.length > 0,
    };
  });

  // 1. Bulk insert transactions (idempotent on store_id + seq)
  const txValues = [];
  const txPlaceholders = preparedTxs.map((tx, idx) => {
    const base = idx * 19;
    txValues.push(
      parsed.storeId,
      tx.seq,
      parsed.businessDate,
      parsed.batchSeq,
      filename,
      tx.txType,
      tx.status,
      tx.deviceId,
      tx.staffId,
      tx.shiftNo,
      tx.startedAt,
      tx.endedAt,
      tx.originalSeq,
      tx.netAmount,
      tx.taxAmount,
      tx.giftCardLoadAmount,
      tx.grandTotal,
      tx.needsReview,
      tx.uniqueReasons,
    );
    return `(${Array.from({ length: 19 }, (_, c) => `$${base + c + 1}`).join(",")})`;
  });

  const txInsert = await client.query(
    `INSERT INTO transactions
       (store_id, seq, business_date, batch_seq, source_file, tx_type, status, device_id,
        staff_id, shift_no, started_at, ended_at, original_seq, net_amount, tax_amount,
        gift_card_load_amount, grand_total, needs_review, review_reasons)
     VALUES ${txPlaceholders.join(",")}
     ON CONFLICT (store_id, seq) DO NOTHING
     RETURNING id, seq`,
    txValues,
  );

  const insertedMap = new Map(txInsert.rows.map((r) => [String(r.seq), r.id]));
  const accepted = insertedMap.size;
  const duplicatesSkipped = preparedTxs.length - accepted;
  let rowsFlagged = 0;

  const lineValues = [];
  const linePlaceholders = [];
  const taxValues = [];
  const taxPlaceholders = [];
  const tenderValues = [];
  const tenderPlaceholders = [];

  for (const tx of preparedTxs) {
    const txId = insertedMap.get(String(tx.seq));
    if (!txId) continue;

    if (tx.needsReview) rowsFlagged++;

    tx.lines.forEach((l, i) => {
      const lReasons = tx.lineFlags[i];
      const base = lineValues.length;
      lineValues.push(
        txId,
        l.lineNo,
        l.lineType,
        l.itemCode,
        l.variant,
        l.description,
        l.deptCode,
        l.qty,
        l.unitPrice,
        l.amount,
        l.taxGroup,
        l.status,
        l.cardLast4,
        l.envelopeNo,
        lReasons.length > 0,
        lReasons.join("; ") || null,
      );
      linePlaceholders.push(
        `(${Array.from({ length: 16 }, (_, c) => `$${base + c + 1}`).join(",")})`,
      );
    });

    for (const t of tx.taxes) {
      const base = taxValues.length;
      taxValues.push(txId, t.taxGroup, t.taxableAmount, t.taxAmount);
      taxPlaceholders.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4})`,
      );
    }

    for (const p of tx.tenders) {
      const base = tenderValues.length;
      tenderValues.push(
        txId,
        p.tenderType,
        p.amount,
        p.tendered,
        p.changeGiven,
        p.cardType,
        p.cardLast4,
        p.authCode,
        p.wallet,
        p.accountId,
      );
      tenderPlaceholders.push(
        `(${Array.from({ length: 10 }, (_, c) => `$${base + c + 1}`).join(",")})`,
      );
    }
  }

  // 2. Bulk insert lines, taxes, and tenders
  if (linePlaceholders.length > 0) {
    await client.query(
      `INSERT INTO transaction_lines
         (transaction_id, line_no, line_type, item_code, variant, description, dept_code,
          qty, unit_price, amount, tax_group, status, card_last4, envelope_no, needs_review, review_reason)
       VALUES ${linePlaceholders.join(",")}`,
      lineValues,
    );
  }

  if (taxPlaceholders.length > 0) {
    await client.query(
      `INSERT INTO transaction_taxes (transaction_id, tax_group, taxable_amount, tax_amount)
       VALUES ${taxPlaceholders.join(",")}`,
      taxValues,
    );
  }

  if (tenderPlaceholders.length > 0) {
    await client.query(
      `INSERT INTO transaction_tenders
         (transaction_id, tender_type, amount, tendered, change_given, card_type, card_last4, auth_code, wallet, account_id)
       VALUES ${tenderPlaceholders.join(",")}`,
      tenderValues,
    );
  }

  return { accepted, duplicatesSkipped, rowsFlagged };
}

async function handleAckFile(client, parsed) {
  await client.query(
    `UPDATE price_change_batches
     SET status = $1, acked_at = NOW()
     WHERE change_id = $2`,
    [parsed.result, parsed.changeId],
  );

  for (const item of parsed.items) {
    await client.query(
      `UPDATE price_change_items
       SET status = $1, error_code = $2, error_message = $3
       WHERE change_id = $4 AND item_code = $5 AND variant = $6`,
      [
        item.result,
        item.errorCode,
        item.message,
        parsed.changeId,
        item.itemCode,
        item.variant,
      ],
    );

    if (item.result === "APPLIED") {
      if (item.action === "deactivate") {
        await client.query(
          `UPDATE items
           SET is_active = FALSE, updated_at = NOW()
           WHERE store_id = $1 AND item_code = $2 AND variant = $3`,
          [parsed.storeId, item.itemCode, item.variant],
        );
      } else if (item.action === "add") {
        await client.query(
          `INSERT INTO items
             (store_id, item_code, variant, description, dept_code, price, tax_group, min_age, unit, containers, is_active)
           SELECT $1, pci.item_code, pci.variant, COALESCE(pci.description, pci.item_code),
                  pci.dept_code, COALESCE(pci.new_price, 0.00), COALESCE(pci.tax_group, 'T0'),
                  COALESCE(pci.min_age, 0), COALESCE(pci.unit, 'EA'), COALESCE(pci.containers, 0), TRUE
           FROM price_change_items pci
           WHERE pci.change_id = $2 AND pci.item_code = $3 AND pci.variant = $4
           ON CONFLICT (store_id, item_code, variant) DO UPDATE SET
             price = EXCLUDED.price,
             description = EXCLUDED.description,
             dept_code = EXCLUDED.dept_code,
             tax_group = EXCLUDED.tax_group,
             is_active = TRUE,
             updated_at = NOW()`,
          [parsed.storeId, parsed.changeId, item.itemCode, item.variant],
        );
      } else {
        await client.query(
          `UPDATE items i
           SET price = COALESCE(pci.new_price, i.price),
               description = COALESCE(pci.description, i.description),
               dept_code = COALESCE(pci.dept_code, i.dept_code),
               tax_group = COALESCE(pci.tax_group, i.tax_group),
               updated_at = NOW()
           FROM price_change_items pci
           WHERE pci.change_id = $1 AND pci.item_code = $2 AND pci.variant = $3
             AND i.store_id = $4 AND i.item_code = pci.item_code AND i.variant = pci.variant`,
          [parsed.changeId, item.itemCode, item.variant, parsed.storeId],
        );
      }
    }
  }
}

function extractStoreHint(filename) {
  const match = filename.match(/_(BL\d+)_/);
  return match ? match[1] : null;
}
