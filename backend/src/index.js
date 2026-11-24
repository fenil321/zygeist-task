import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import Decimal from "decimal.js";
import path from "path";
import { pool } from "./db.js";
import { seedMasterData } from "./seedMaster.js";
import { startOutboxWatcher } from "./services/watcher.js";
import { reconcileStoreDay } from "./services/reconciliation.js";
import {
  getBusinessAccountStatements,
  previewBulkPriceRule,
  sendPriceChangeBatch,
} from "./services/priceSync.js";
import aiRouter from "./routes/ai.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use("/api/ai", aiRouter);

const PORT = Number(process.env.PORT || 8000);
const OUTBOX_DIR = path.resolve(
  process.env.HUB_OUTBOX_DIR || "../runtime_hub/outbox",
);
const INBOX_DIR = path.resolve(
  process.env.HUB_INBOX_DIR || "../runtime_hub/inbox",
);

// --- Live SSE Clients ---
const sseClients = new Set();

function broadcastEvent(payload) {
  const msg = `data: ${JSON.stringify({ ...payload, ts: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "CONNECTED" })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// --- Metadata (Stores, Dates, Departments) ---
app.get("/api/meta", async (req, res) => {
  const stores = await pool.query("SELECT * FROM stores ORDER BY store_id");
  const dates = await pool.query(
    `SELECT DISTINCT store_id, TO_CHAR(business_date, 'YYYY-MM-DD') AS business_date
   FROM (
     SELECT store_id, business_date FROM transactions
     UNION
     SELECT store_id, business_date FROM eod_summaries
   ) d
   ORDER BY business_date DESC`,
  );
  const depts = await pool.query(
    "SELECT * FROM departments ORDER BY dept_code",
  );
  res.json({
    stores: stores.rows,
    availableDates: dates.rows,
    departments: depts.rows,
  });
});

// --- Module 2: Operations Dashboard (Daily View) ---
app.get("/api/dashboard", async (req, res) => {
  try {
    const { storeId = "BL01", date } = req.query;
    let targetDate = date;

    if (!targetDate) {
      const latest = await pool.query(
        `SELECT TO_CHAR(MAX(business_date), 'YYYY-MM-DD') AS d FROM transactions WHERE store_id = $1`,
        [storeId],
      );
      targetDate = latest.rows[0]?.d || "2026-10-01";
    }

    // 1. Headlines (Total, Counter R*, Self-Checkout K*, Tx count, Avg basket, Gift Card Loads)
    const headlineRes = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tx_type IN ('SALE','REFUND') THEN net_amount ELSE 0 END), 0) AS total_net_sales,
         COALESCE(SUM(CASE WHEN tx_type IN ('SALE','REFUND') AND device_id LIKE 'R%' THEN net_amount ELSE 0 END), 0) AS counter_sales,
         COALESCE(SUM(CASE WHEN tx_type IN ('SALE','REFUND') AND device_id LIKE 'K%' THEN net_amount ELSE 0 END), 0) AS self_checkout_sales,
         COUNT(CASE WHEN tx_type IN ('SALE','REFUND') THEN 1 END)::int AS tx_count,
         COALESCE(SUM(gift_card_load_amount), 0) AS gift_card_loads
       FROM transactions
       WHERE store_id = $1 AND business_date = $2 AND status = 'COMPLETED'`,
      [storeId, targetDate],
    );
    const h = headlineRes.rows[0];
    const avgBasket =
      h.tx_count > 0
        ? new Decimal(h.total_net_sales)
            .div(h.tx_count)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(2)
        : "0.00";

    // 2. Sales by Hour (07:00 - 21:00)
    const hourlyRes = await pool.query(
      `SELECT
         EXTRACT(HOUR FROM started_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
         COALESCE(SUM(net_amount), 0) AS net_sales,
         COUNT(*)::int AS tx_count
       FROM transactions
       WHERE store_id = $1 AND business_date = $2
         AND status = 'COMPLETED' AND tx_type IN ('SALE', 'REFUND')
       GROUP BY 1
       ORDER BY 1`,
      [storeId, targetDate],
    );

    // 3. Tenders breakdown
    const tendersRes = await pool.query(
      `SELECT tp.tender_type, COUNT(*)::int AS count, COALESCE(SUM(tp.amount), 0) AS total
       FROM transaction_tenders tp
       JOIN transactions t ON t.id = tp.transaction_id
       WHERE t.store_id = $1 AND t.business_date = $2
         AND t.status = 'COMPLETED' AND t.tx_type IN ('SALE', 'REFUND')
       GROUP BY 1
       ORDER BY total DESC`,
      [storeId, targetDate],
    );

    // 4. Department breakdown (ACTIVE lines on COMPLETED SALE/REFUND)
    const deptRes = await pool.query(
      `SELECT COALESCE(tl.dept_code, '99') AS dept_code,
              COALESCE(d.name, 'Dept ' || COALESCE(tl.dept_code, '99')) AS dept_name,
              COALESCE(SUM(tl.qty), 0) AS quantity,
              COALESCE(SUM(tl.amount), 0) AS sales
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       LEFT JOIN departments d ON d.dept_code = tl.dept_code
       WHERE t.store_id = $1 AND t.business_date = $2
         AND t.status = 'COMPLETED' AND t.tx_type IN ('SALE', 'REFUND')
         AND tl.line_type = 'ITEM' AND tl.status = 'ACTIVE'
       GROUP BY 1, 2
       ORDER BY sales DESC`,
      [storeId, targetDate],
    );

    // 5. Watch List (voids, cancelled transactions, refunds, no-sales, cash drops — newest first)
    const watchRes = await pool.query(
      `SELECT DISTINCT t.id, t.seq, t.tx_type, t.status, t.device_id, t.staff_id,
              COALESCE(s.name, 'Kiosk / Unknown') AS staff_name,
              t.started_at, t.grand_total,
              EXISTS(SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = t.id AND tl.status = 'VOID') AS has_voided_line
       FROM transactions t
       LEFT JOIN staff s ON s.staff_id = t.staff_id
       WHERE t.store_id = $1 AND t.business_date = $2
         AND (
           t.status = 'CANCELLED'
           OR t.tx_type IN ('REFUND', 'NO_SALE', 'CASH_DROP')
           OR EXISTS(SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = t.id AND tl.status = 'VOID')
         )
       ORDER BY t.started_at DESC, t.seq DESC
       LIMIT 50`,
      [storeId, targetDate],
    );

    res.json({
      storeId,
      businessDate: targetDate,
      headlines: {
        totalSales: h.total_net_sales,
        counterSales: h.counter_sales,
        selfCheckoutSales: h.self_checkout_sales,
        transactionCount: h.tx_count,
        averageBasket: avgBasket,
        giftCardLoads: h.gift_card_loads,
      },
      hourlySales: hourlyRes.rows,
      tenders: tendersRes.rows,
      departments: deptRes.rows,
      watchList: watchRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Module 2: Transactions Search, Filters & Line Detail ---
app.get("/api/transactions", async (req, res) => {
  try {
    const {
      storeId,
      dateFrom,
      dateTo,
      deptCode,
      tenderType,
      eventType,
      search,
      limit = 100,
    } = req.query;
    const conds = ["1=1"];
    const params = [];

    if (storeId) {
      params.push(storeId);
      conds.push(`t.store_id = $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      conds.push(`t.business_date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      conds.push(`t.business_date <= $${params.length}`);
    }
    if (deptCode) {
      params.push(deptCode);
      conds.push(
        `EXISTS (SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = t.id AND tl.dept_code = $${params.length})`,
      );
    }
    if (tenderType) {
      params.push(tenderType.toUpperCase());
      conds.push(
        `EXISTS (SELECT 1 FROM transaction_tenders tp WHERE tp.transaction_id = t.id AND tp.tender_type = $${params.length})`,
      );
    }
    if (eventType) {
      const ev = eventType.toUpperCase();
      if (ev === "VOID") {
        conds.push(
          `EXISTS (SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = t.id AND tl.status = 'VOID')`,
        );
      } else if (ev === "CANCELLED") {
        conds.push(`t.status = 'CANCELLED'`);
      } else if (ev === "FLAGGED") {
        conds.push(`t.needs_review = TRUE`);
      } else {
        params.push(ev);
        conds.push(`t.tx_type = $${params.length}`);
      }
    }
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conds.push(`(CAST(t.seq AS TEXT) ILIKE $${idx} OR EXISTS (
        SELECT 1 FROM transaction_lines tl WHERE tl.transaction_id = t.id
          AND (tl.description ILIKE $${idx} OR tl.item_code ILIKE $${idx})
      ))`);
    }

    params.push(Number(limit));
    const rows = await pool.query(
      `SELECT t.*, COALESCE(s.name, 'Self-Checkout') AS staff_name
       FROM transactions t
       LEFT JOIN staff s ON s.staff_id = t.staff_id
       WHERE ${conds.join(" AND ")}
       ORDER BY t.business_date DESC, t.seq DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ transactions: rows.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/transactions/:id", async (req, res) => {
  const txRes = await pool.query("SELECT * FROM transactions WHERE id = $1", [
    req.params.id,
  ]);
  if (txRes.rowCount === 0)
    return res.status(404).json({ error: "Transaction not found" });

  const lines = await pool.query(
    "SELECT * FROM transaction_lines WHERE transaction_id = $1 ORDER BY line_no",
    [req.params.id],
  );
  const tenders = await pool.query(
    "SELECT * FROM transaction_tenders WHERE transaction_id = $1",
    [req.params.id],
  );
  const taxes = await pool.query(
    "SELECT * FROM transaction_taxes WHERE transaction_id = $1",
    [req.params.id],
  );

  res.json({
    transaction: txRes.rows[0],
    lines: lines.rows,
    tenders: tenders.rows,
    taxes: taxes.rows,
  });
});

// --- Module 3: End-of-Day Reconciliation ---
app.get("/api/reconciliation", async (req, res) => {
  try {
    const { storeId = "BL01", date = "2026-10-10" } = req.query;
    const report = await reconcileStoreDay(storeId, date);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Module 4: Price List, Bulk Preview, Change Submission & Business Accounts ---
app.get("/api/items", async (req, res) => {
  const { storeId = "BL01", deptCode, search } = req.query;
  const conds = ["i.store_id = $1"];
  const params = [storeId];

  if (deptCode) {
    params.push(deptCode);
    conds.push(`i.dept_code = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conds.push(`(i.item_code ILIKE $${idx} OR i.description ILIKE $${idx})`);
  }

  const rows = await pool.query(
    `SELECT i.*, d.name AS dept_name
     FROM items i
     LEFT JOIN departments d ON d.dept_code = i.dept_code
     WHERE ${conds.join(" AND ")}
     ORDER BY i.dept_code, i.description, i.variant`,
    params,
  );
  res.json({ items: rows.rows });
});

app.post("/api/prices/preview-bulk", async (req, res) => {
  try {
    const preview = await previewBulkPriceRule(req.body);
    res.json({ preview });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/prices/changes", async (req, res) => {
  try {
    const { storeId, changeId, items } = req.body;
    const result = await sendPriceChangeBatch({
      storeId,
      changeId,
      items,
      inboxDir: INBOX_DIR,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/prices/changes", async (req, res) => {
  const batches = await pool.query(
    "SELECT * FROM price_change_batches ORDER BY sent_at DESC",
  );
  const items = await pool.query(
    "SELECT * FROM price_change_items ORDER BY id",
  );
  res.json({ batches: batches.rows, items: items.rows });
});

app.get("/api/business-accounts", async (req, res) => {
  const { month } = req.query;
  const statements = await getBusinessAccountStatements(month);
  res.json({ statements });
});

// --- Module 1 Audit & Quarantine Logs ---
app.get("/api/audit", async (req, res) => {
  const history = await pool.query(
    "SELECT * FROM import_history ORDER BY processed_at DESC LIMIT 100",
  );
  const quarantined = await pool.query(
    "SELECT * FROM quarantined_files ORDER BY quarantined_at DESC",
  );
  res.json({ history: history.rows, quarantined: quarantined.rows });
});

// --- Bootstrap ---
async function start() {
  await seedMasterData();
  await startOutboxWatcher(OUTBOX_DIR, broadcastEvent);

  app.listen(PORT, () => {
    console.log(
      `[API] Brightleaf Operations Backend running on http://localhost:${PORT}`,
    );
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
