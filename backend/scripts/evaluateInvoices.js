import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { pool } from "../src/db.js";
import { processSupplierInvoice } from "../src/services/invoiceCapture.js";

dotenv.config();

const INVOICES_DIR = path.resolve("../data_package/invoices");
const OUT_PATH = path.resolve("./invoice_eval_report.json");
const FRESH_RUN = process.argv.includes("--fresh");

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return null;
}

async function loadPreviousSuccesses() {
  if (FRESH_RUN) return new Map();
  try {
    const raw = await fs.readFile(OUT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const map = new Map();
    for (const r of parsed.results || []) {
      if (r.status === "SUCCESS") map.set(r.filename, r);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function saveReport(invoiceFiles, results) {
  const succeededList = results.filter((r) => r.status === "SUCCESS");
  const totalLines = succeededList.reduce(
    (acc, r) => acc + (r.lines?.length || 0),
    0,
  );
  const matchedCatalogLines = succeededList.reduce(
    (acc, r) =>
      acc +
      (r.lines?.filter((l) => l.suggestedAction === "update").length || 0),
    0,
  );
  const mathDiscrepanciesCaught = succeededList.filter(
    (r) => r.mathValid === false,
  ).length;

  const summary = {
    evaluatedAt: new Date().toISOString(),
    invoiceCount: invoiceFiles.length,
    succeeded: succeededList.length,
    totalLineItemsExtracted: totalLines,
    catalogMatchedLines: matchedCatalogLines,
    catalogMatchRatePct:
      totalLines > 0
        ? Number(((matchedCatalogLines / totalLines) * 100).toFixed(1))
        : 0,
    invoicesWithMathDiscrepanciesFlagged: mathDiscrepanciesCaught,
    results,
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

async function runEvaluation() {
  const entries = await fs.readdir(INVOICES_DIR, { withFileTypes: true });
  const invoiceFiles = entries
    .filter((e) => e.isFile() && getMimeType(e.name) !== null)
    .map((e) => e.name)
    .sort();

  const cached = await loadPreviousSuccesses();
  console.log(
    `\n=== Brightleaf AI Invoice Extraction Evaluation (${invoiceFiles.length} invoices) ===\n`,
  );

  const results = [];

  for (const filename of invoiceFiles) {
    if (cached.has(filename)) {
      const prev = cached.get(filename);
      console.log(
        `[CACHED PASS] ${filename} (${prev.latencyMs} ms) -> ${prev.supplierName} | Total: $${prev.totalAmount} | Math Valid: ${prev.mathValid}\n`,
      );
      results.push(prev);
      continue;
    }

    const filePath = path.join(INVOICES_DIR, filename);
    const buffer = await fs.readFile(filePath);
    const mimeType = getMimeType(filename);

    const startMs = Date.now();
    try {
      const extracted = await processSupplierInvoice({
        buffer,
        mimeType,
        filename,
        storeId: "BL01",
        targetMargin: 35,
        persist: false,
      });
      const latencyMs = Date.now() - startMs;

      const lineCount = extracted.lines.length;
      const matchedCount = extracted.lines.filter(
        (l) => l.suggestedAction === "update",
      ).length;

      console.log(`[PASS] ${filename} (${latencyMs} ms)`);
      console.log(
        `       Supplier: ${extracted.supplierName} | Invoice #: ${extracted.invoiceNumber} | Date: ${extracted.invoiceDate}`,
      );
      console.log(
        `       Printed Total: $${extracted.totalAmount} | Computed Total: $${extracted.computedTotalAmount} | Math Valid: ${extracted.mathValid}`,
      );
      console.log(
        `       Lines: ${lineCount} (${matchedCount} matched to BL01 catalog, ${lineCount - matchedCount} new SKU proposals)`,
      );
      if (extracted.discrepancies.length > 0) {
        extracted.discrepancies.forEach((d) =>
          console.log(`       [DISCREPANCY FLAGGED] ${d}`),
        );
      }
      if (extracted.extractionNotes.length > 0) {
        console.log(`       [NOTES] ${extracted.extractionNotes.join(" | ")}`);
      }
      console.log("");

      results.push({ filename, status: "SUCCESS", latencyMs, ...extracted });
      await saveReport(invoiceFiles, results);
    } catch (err) {
      console.error(`[FAIL] ${filename}: ${err.message}\n`);
      results.push({ filename, status: "ERROR", error: err.message });
      await saveReport(invoiceFiles, results);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  const finalSummary = await saveReport(invoiceFiles, results);
  console.log(
    `=== Evaluation Complete: ${finalSummary.succeeded}/${finalSummary.invoiceCount} succeeded | Report saved to ${OUT_PATH} ===\n`,
  );

  await pool.end();
}

runEvaluation().catch((err) => {
  console.error(err);
  process.exit(1);
});
