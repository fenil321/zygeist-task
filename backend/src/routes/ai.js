import express from "express";
import multer from "multer";
import path from "path";
import {
  approveInvoiceAndPushPrices,
  getSupplierInvoiceDetail,
  listSupplierInvoices,
  processSupplierInvoice,
} from "../services/invoiceCapture.js";
import {
  askYourStores,
  generateDailyLossPreventionSummary,
} from "../services/storeInsights.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB max invoice upload
});

const INBOX_DIR = path.resolve(
  process.env.HUB_INBOX_DIR || "../runtime_hub/inbox",
);

// --- 5A: Supplier Invoice Capture ---
router.post("/invoices/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No invoice file uploaded (field name: file)" });
    }
    const { storeId = "BL01", targetMargin = "35" } = req.body;
    const result = await processSupplierInvoice({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
      storeId,
      targetMargin: Number(targetMargin),
      persist: true,
    });
    res.json(result);
  } catch (err) {
    console.error("[AI INVOICE ERROR]", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/invoices", async (req, res) => {
  try {
    const invoices = await listSupplierInvoices();
    res.json({ invoices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/invoices/:id", async (req, res) => {
  try {
    const detail = await getSupplierInvoiceDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Invoice not found" });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/invoices/:id/approve", async (req, res) => {
  try {
    const { lines, pushToHub = true } = req.body;
    const result = await approveInvoiceAndPushPrices({
      invoiceId: req.params.id,
      linesOverride: lines,
      inboxDir: INBOX_DIR,
      pushToHub,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 5C: Daily Loss-Prevention Summary ---
router.get("/loss-prevention", async (req, res) => {
  try {
    const { storeId = "BL01", date = "2026-10-10" } = req.query;
    const summary = await generateDailyLossPreventionSummary(storeId, date);
    res.json(summary);
  } catch (err) {
    console.error("[AI LP ERROR]", err);
    res.status(500).json({ error: err.message });
  }
});

// --- 5B: Ask Your Stores ---
router.post("/ask", async (req, res) => {
  try {
    const { question, storeId, dateFrom, dateTo } = req.body;
    const response = await askYourStores({
      question,
      storeId,
      dateFrom,
      dateTo,
    });
    res.json(response);
  } catch (err) {
    console.error("[AI ASK ERROR]", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
