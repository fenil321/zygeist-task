import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { pool } from "../db.js";
import { reconcileStoreDay } from "./reconciliation.js";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function generateWithRetry(params, maxRounds = 3) {
  const baseModels = [
    process.env.GEMINI_MODEL,
    process.env.GEMINI_FALLBACK_MODEL,
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
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
    `Gemini insights failed after ${maxRounds} rounds. Last error: ${lastError?.message || lastError}`,
  );
}

const LP_SUMMARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    risk_level: { type: Type.STRING, description: "LOW, MEDIUM, or HIGH" },
    executive_summary: {
      type: Type.STRING,
      description: "2-3 sentence operational brief for the store manager",
    },
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: {
            type: Type.STRING,
            description:
              "VOIDS, REFUNDS, NO_SALES, CASH_VARIANCE, or DATA_INTEGRITY",
          },
          severity: { type: Type.STRING, description: "LOW, MEDIUM, or HIGH" },
          title: { type: Type.STRING },
          evidence_citations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              "Exact seq numbers, staff IDs, registers, or filenames from the facts provided",
          },
          dollar_impact: { type: Type.STRING },
          recommended_action: { type: Type.STRING },
        },
        required: [
          "category",
          "severity",
          "title",
          "evidence_citations",
          "dollar_impact",
          "recommended_action",
        ],
      },
    },
  },
  required: ["risk_level", "executive_summary", "findings"],
};

// Module 5C: Grounded Daily Loss-Prevention & Exception Summary
export async function generateDailyLossPreventionSummary(
  storeId = "BL01",
  date = "2026-10-10",
) {
  const [exceptionsRes, staffStatsRes, quarantinedRes, reconciliation] =
    await Promise.all([
      pool.query(
        `SELECT t.seq, t.tx_type, t.status, t.device_id, t.staff_id,
              COALESCE(s.name, 'Self-Checkout') AS staff_name,
              t.original_seq, t.net_amount, t.grand_total, t.needs_review, t.review_reasons,
              TO_CHAR(t.started_at AT TIME ZONE 'America/Los_Angeles', 'HH24:MI:SS') AS local_time,
              (SELECT COALESCE(SUM(ABS(tl.amount)), 0)
               FROM transaction_lines tl
               WHERE tl.transaction_id = t.id AND tl.status = 'VOID') AS voided_line_amount
       FROM transactions t
       LEFT JOIN staff s ON s.staff_id = t.staff_id
       WHERE t.store_id = $1 AND t.business_date = $2
         AND (
           t.status = 'CANCELLED'
           OR t.tx_type IN ('REFUND', 'NO_SALE', 'CASH_DROP')
           OR t.needs_review = TRUE
           OR EXISTS (SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = t.id AND tl.status = 'VOID')
         )
       ORDER BY t.seq`,
        [storeId, date],
      ),
      pool.query(
        `SELECT t.staff_id, COALESCE(s.name, 'Self-Checkout') AS staff_name, t.device_id,
              COUNT(CASE WHEN t.status = 'COMPLETED' AND t.tx_type = 'SALE' THEN 1 END)::int AS sales_count,
              COUNT(CASE WHEN t.status = 'CANCELLED' THEN 1 END)::int AS cancelled_count,
              COUNT(CASE WHEN t.tx_type = 'NO_SALE' THEN 1 END)::int AS no_sale_count,
              COUNT(CASE WHEN t.tx_type = 'REFUND' THEN 1 END)::int AS refund_count,
              COALESCE(SUM(CASE WHEN t.tx_type = 'REFUND' THEN ABS(t.grand_total) ELSE 0 END), 0) AS refund_total
       FROM transactions t
       LEFT JOIN staff s ON s.staff_id = t.staff_id
       WHERE t.store_id = $1 AND t.business_date = $2
       GROUP BY t.staff_id, s.name, t.device_id
       ORDER BY t.device_id, t.staff_id`,
        [storeId, date],
      ),
      pool.query(
        `SELECT filename, error_reason FROM quarantined_files WHERE store_id = $1`,
        [storeId],
      ),
      reconcileStoreDay(storeId, date),
    ]);

  const nonMatchedRecChecks = [
    ...(reconciliation.headlineChecks || []),
    ...(reconciliation.departmentChecks || []),
    ...(reconciliation.tenderChecks || []),
    ...(reconciliation.internalConsistency || []),
    ...(reconciliation.shiftCashChecks || []),
  ].filter((c) => c.status !== "MATCHED");

  const groundedFacts = {
    storeId,
    businessDate: date,
    exceptionEvents: exceptionsRes.rows,
    staffAndRegisterBreakdown: staffStatsRes.rows,
    reconciliationDiscrepancies: nonMatchedRecChecks,
    quarantinedStoreFiles: quarantinedRes.rows,
  };

  const prompt = `You are a retail loss-prevention and store operations auditor for Brightleaf Market.
Analyze the grounded operational facts below for store ${storeId} on ${date}.
Rules:
1. Cite ONLY exact transaction sequence numbers (seq), staff IDs/names, registers (device_id), filenames, and dollar amounts present in the JSON below.
2. Highlight specific risk patterns: unreferenced refunds (original_seq is null), high void/cancellation concentrations on a specific staff member or register, frequent NO_SALE drawer openings, cash drawer over/short variances, or missing/quarantined batches.
3. Never invent numbers or events not present in the facts.

FACTS:
${JSON.stringify(groundedFacts, null, 2)}`;

  const response = await generateWithRetry({
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: LP_SUMMARY_SCHEMA,
      temperature: 0.15,
    },
  });

  const aiReport = JSON.parse(response.text);
  return {
    storeId,
    businessDate: date,
    metrics: {
      exceptionEventCount: exceptionsRes.rowCount,
      reconciliationMismatchCount: nonMatchedRecChecks.length,
      quarantinedFileCount: quarantinedRes.rowCount,
    },
    report: aiReport,
  };
}

// Module 5B: Ask Your Stores (Grounded Natural-Language Q&A)
export async function askYourStores({
  question,
  storeId = null,
  dateFrom = "2026-10-01",
  dateTo = "2026-10-14",
}) {
  if (!question || !question.trim()) {
    throw new Error("Question is required");
  }

  const storeFilter = storeId ? "AND t.store_id = $3" : "";
  const params = storeId ? [dateFrom, dateTo, storeId] : [dateFrom, dateTo];

  const [
    dailySales,
    topItems,
    deptSales,
    tenderMix,
    exceptionSummary,
    quarantined,
  ] = await Promise.all([
    pool.query(
      `SELECT t.store_id, TO_CHAR(t.business_date, 'YYYY-MM-DD') AS business_date,
              COUNT(CASE WHEN t.tx_type IN ('SALE','REFUND') AND t.status = 'COMPLETED' THEN 1 END)::int AS tx_count,
              COALESCE(SUM(CASE WHEN t.tx_type IN ('SALE','REFUND') AND t.status = 'COMPLETED' THEN t.net_amount ELSE 0 END), 0) AS net_sales,
              COALESCE(SUM(CASE WHEN t.tx_type IN ('SALE','REFUND') AND t.status = 'COMPLETED' AND t.device_id LIKE 'K%' THEN t.net_amount ELSE 0 END), 0) AS kiosk_sales,
              COALESCE(SUM(CASE WHEN t.tx_type IN ('SALE','REFUND') AND t.status = 'COMPLETED' AND t.device_id LIKE 'R%' THEN t.net_amount ELSE 0 END), 0) AS counter_sales
       FROM transactions t
       WHERE t.business_date BETWEEN $1 AND $2 ${storeFilter}
       GROUP BY t.store_id, t.business_date
       ORDER BY t.business_date, t.store_id`,
      params,
    ),
    pool.query(
      `SELECT t.store_id, tl.item_code, tl.description,
              SUM(tl.qty) AS total_qty, SUM(tl.amount) AS total_sales
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE t.business_date BETWEEN $1 AND $2 ${storeFilter}
         AND t.status = 'COMPLETED' AND t.tx_type = 'SALE'
         AND tl.line_type = 'ITEM' AND tl.status = 'ACTIVE' AND tl.item_code IS NOT NULL
       GROUP BY t.store_id, tl.item_code, tl.description
       ORDER BY total_sales DESC
       LIMIT 25`,
      params,
    ),
    pool.query(
      `SELECT t.store_id, COALESCE(tl.dept_code, '99') AS dept_code,
              COALESCE(d.name, 'Unknown') AS dept_name,
              SUM(tl.qty) AS total_qty, SUM(tl.amount) AS total_sales
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       LEFT JOIN departments d ON d.dept_code = tl.dept_code
       WHERE t.business_date BETWEEN $1 AND $2 ${storeFilter}
         AND t.status = 'COMPLETED' AND t.tx_type IN ('SALE','REFUND')
         AND tl.line_type = 'ITEM' AND tl.status = 'ACTIVE'
       GROUP BY t.store_id, tl.dept_code, d.name
       ORDER BY total_sales DESC`,
      params,
    ),
    pool.query(
      `SELECT t.store_id, tp.tender_type, COUNT(*)::int AS count, SUM(tp.amount) AS total
       FROM transaction_tenders tp
       JOIN transactions t ON t.id = tp.transaction_id
       WHERE t.business_date BETWEEN $1 AND $2 ${storeFilter}
         AND t.status = 'COMPLETED' AND t.tx_type IN ('SALE','REFUND')
       GROUP BY t.store_id, tp.tender_type
       ORDER BY total DESC`,
      params,
    ),
    pool.query(
      `SELECT t.store_id, t.staff_id, COALESCE(s.name, 'Self-Checkout') AS staff_name,
              COUNT(CASE WHEN t.status = 'CANCELLED' THEN 1 END)::int AS cancelled_txs,
              COUNT(CASE WHEN t.tx_type = 'REFUND' THEN 1 END)::int AS refunds,
              COUNT(CASE WHEN t.tx_type = 'NO_SALE' THEN 1 END)::int AS no_sales,
              COALESCE(SUM((SELECT SUM(ABS(tl.amount)) FROM transaction_lines tl WHERE tl.transaction_id = t.id AND tl.status = 'VOID')), 0) AS voided_amount
       FROM transactions t
       LEFT JOIN staff s ON s.staff_id = t.staff_id
       WHERE t.business_date BETWEEN $1 AND $2 ${storeFilter}
       GROUP BY t.store_id, t.staff_id, s.name`,
      params,
    ),
    pool.query(
      "SELECT store_id, filename, error_reason FROM quarantined_files",
    ),
  ]);

  const contextPayload = {
    window: { dateFrom, dateTo, storeFilter: storeId || "ALL_STORES" },
    dailySalesByStore: dailySales.rows,
    departmentSales: deptSales.rows,
    topSellingItems: topItems.rows,
    tenderBreakdown: tenderMix.rows,
    staffExceptions: exceptionSummary.rows,
    quarantinedFiles: quarantined.rows,
  };

  const prompt = `You are the Brightleaf Market retail operations analyst.
Answer the manager's question using ONLY the verified PostgreSQL store records provided below.
Rules:
- Cite specific store IDs (BL01, BL02), dates, item codes, staff names, and exact dollar amounts.
- If the provided records do not contain the data needed to answer part of the question, state that clearly rather than guessing.
- Keep the answer concise, structured with bullet points where helpful, and directly actionable.

MANAGER QUESTION: ${question}

STORE DATA:
${JSON.stringify(contextPayload, null, 2)}`;

  const response = await generateWithRetry({
    contents: prompt,
    config: {
      temperature: 0.2,
    },
  });

  return {
    question,
    scope: { storeId: storeId || "ALL", dateFrom, dateTo },
    answer: response.text,
  };
}
