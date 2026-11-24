# Brightleaf Market · Store Operations & Reconciliation Platform

Full-stack store operations, POS transaction reconciliation, two-way price synchronization, and Gemini-powered retail intelligence platform built for **Brightleaf Market** (`BL01` Downtown & `BL02` Westside).

---

## Architecture & Core Modules

```text
Task-1/
├── backend/                  # Express.js REST API, SSE stream, PostgreSQL ingestion & Gemini AI services
│   ├── scripts/              # Invoice benchmark evaluator & synthetic test invoice generator
│   └── src/
│       ├── routes/           # /api/ai/* endpoints (invoice capture, loss prevention, store Q&A)
│       ├── services/         # Reconciliation engine, Hub price sync, invoice OCR, store insights
│       ├── db.js             # PostgreSQL connection pool (IPv4-first DNS resolution)
│       ├── index.js          # Express server, SSE /api/events, & live outbox file watcher
│       └── seedMaster.js     # Master data seeder (stores, devices, staff, business accounts, catalog)
├── frontend/                 # Next.js (App Router) + Tailwind CSS + Lucide React operations dashboard
│   └── src/
│       ├── app/page.js       # Main command center with live SSE status & store/date selectors
│       ├── components/       # 5-tab UI (Reconciliation, AI Invoices, Catalog Sync, AI Insights, Audit)
│       └── lib/api.js        # Centralized fetch wrapper, currency formatting, & payload normalizers
├── simulator/
│   └── hub_simulator.py      # Hardware-free Python In-Store Hub simulator (inbox/outbox replay & ACKs)
├── data_package/             # Historical POS TLOG/Z-report files (2026-10-01 to 2026-10-14) & supplier invoices
├── database/                 # PostgreSQL schema definitions
└── runtime_hub/              # Live file exchange directory (inbox/ for price batches, outbox/ for POS & ACKs)
```

### 1. Safe Hub File Connector & Quarantine

- Monitors `runtime_hub/outbox` in real time and executes catch-up scans on startup.
- Parses multi-format POS Transaction Logs (`.json` and `.xml`) and end-of-day Z-reports idempotently into PostgreSQL.
- Isolates malformed files (such as `TLOG_BL02_000047.xml` schema errors and `TLOG_BL01_000079.json` `DecimalError` values) into a quarantine audit table without interrupting batch ingestion.

### 2. Real-Time Business Day Dashboard

- Streams live outbox and price-sync updates to the UI via Server-Sent Events (`/api/events`).
- Breaks down daily Net Sales (Kiosk vs. Counter), Sales Tax, Non-Revenue Gift Card Loads, and transaction counts across stores (`BL01`, `BL02`) and business dates (`2026-10-01` – `2026-10-14`).
- Includes a filterable POS Transaction Explorer (`All Events`, `Needs Review`, `Voids / Refunds / No-Sale`) with line-item and tender inspection.

### 3. Totals & Cash Reconciliation Engine

- Independently aggregates raw POS TLOG events and cross-checks them against Z-reports and shift cash drawers across **Headline**, **Department**, **Tender**, **Internal Consistency**, and **Shift Cash** categories.
- Flags variances and operational anomalies (`MATCHED`, `MISMATCH`, `REVIEW_REQUIRED`) with item- and transaction-level explanations.

### 4. Catalog & Two-Way Hub Price Synchronization

- Supports single-item and bulk retail price updates (`UPDATE` and `ADD`) with margin previews.
- Writes outbound price-change batch files to `runtime_hub/inbox/` and processes inbound `ACK_*.xml` confirmations from `runtime_hub/outbox/`, tracking `SENT`, `APPLIED`, `PARTIAL`, and `REJECTED` statuses.

### 5. Gemini AI Operations Suite

- **AI Supplier Invoice Capture (`/api/ai/invoices/*`):** Extracts structured header and line-item data from PDF and image invoices using Google Gemini with automatic retry backoff and multi-model fallback (`gemini-3.5-flash-lite` → `gemini-3.5-flash` → `gemini-3.1-flash-lite`). Matches items against the store catalog, calculates target-margin retail prices, flags line-level/grand-total arithmetic errors and handwritten receiving notes, and pushes approved price batches directly to the Hub.
- **Daily Loss-Prevention Audit (`/api/ai/loss-prevention`):** Generates structured risk assessments citing exact transaction `seq` numbers, staff IDs, void/cancellation totals, no-sale drawer openings, and quarantined files.
- **Ask Your Stores (`/api/ai/ask`):** Answers natural-language operational questions across single or combined stores grounded strictly in verified PostgreSQL telemetry.

### 6. Hardware-Free Python Hub Simulator

- Replays the 287 historical POS files at configurable speeds (`1440x` default or `0` for instant burst) and simulates register processing of outbound `inbox/` price batches into `outbox/ACK_*.xml` responses.
- Supports interactive CLI commands: `[reemit]`, `[corrupt]`, `[status]`, and `[quit]`.

---

## Prerequisites

- **Node.js** v20+ and **npm**
- **Python** 3.10+
- **PostgreSQL** 15+ (local or cloud-hosted via Neon)
- **Google Gemini API Key**

---

## Environment Configuration

Create two environment files before starting the services (ensure both are listed in `.gitignore`):

### `backend/.env`

```env
PORT=8000
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require
GEMINI_API_KEY=<your_gemini_api_key>
```

### `frontend/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

---

## Quick Start (Local Development)

### 1. Install Dependencies & Seed Database

```bash
cd backend
npm install
npm run seed

cd ../frontend
npm install
```

### 2. Run the Three Services

Open three terminals from the project root:

**Terminal 1 — Backend API & Outbox Watcher (`http://localhost:8000`)**

```bash
cd backend
npm run dev
```

**Terminal 2 — Python In-Store Hub Simulator**

```bash
cd backend
npm run hub:sim
```

**Terminal 3 — Next.js Operations Dashboard (`http://localhost:3000`)**

```bash
cd frontend
npm run dev
```

Open **`http://localhost:3000`** in your browser.

---

## Available Backend Scripts

| Command                 | Description                                                                                      |
| :---------------------- | :----------------------------------------------------------------------------------------------- |
| `npm run seed`          | Seeds stores, registers, staff, business accounts, and base item catalog into PostgreSQL.        |
| `npm run dev`           | Starts the Express API server (`:8000`), SSE stream, and live `runtime_hub/outbox` file watcher. |
| `npm start`             | Starts the Express backend in production mode without file watching.                             |
| `npm run hub:sim`       | Launches `simulator/hub_simulator.py` wired to `../data_package` and `../runtime_hub`.           |
| `npm run eval:invoices` | Runs the automated 6-invoice extraction and discrepancy benchmark (`invoice_eval_report.json`).  |

---

## Key API Endpoints

| Method | Endpoint                       | Purpose                                                                      |
| :----- | :----------------------------- | :--------------------------------------------------------------------------- |
| `GET`  | `/api/events`                  | Server-Sent Events (SSE) stream for live Hub ingestion and price ACK updates |
| `GET`  | `/api/dashboard`               | Daily store KPIs (Net Sales, Kiosk/Counter split, Tax, Gift Card Loads)      |
| `GET`  | `/api/reconciliation`          | TLOG vs. Z-Report & Shift Cash reconciliation checks                         |
| `GET`  | `/api/transactions`            | Filtered POS transaction list (`storeId`, `date`, `limit`)                   |
| `GET`  | `/api/transactions/:id`        | Detailed line items, voids, and payment tenders for a single transaction     |
| `GET`  | `/api/items`                   | Store catalog search and active retail pricing                               |
| `POST` | `/api/prices/changes`          | Queues an outbound price-change batch file in `runtime_hub/inbox/`           |
| `GET`  | `/api/prices/changes`          | Lists dispatched price batches and Hub `ACK` statuses                        |
| `GET`  | `/api/business-accounts`       | Corporate house accounts, credit limits, and current balances                |
| `GET`  | `/api/audit`                   | Ingested POS file log and quarantined malformed file records                 |
| `POST` | `/api/ai/invoices/extract`     | Uploads PDF/image supplier invoice for Gemini extraction & catalog matching  |
| `POST` | `/api/ai/invoices/:id/approve` | Approves reviewed retail prices and pushes update batch to Hub               |
| `GET`  | `/api/ai/loss-prevention`      | Generates a cited daily loss-prevention audit brief                          |
| `POST` | `/api/ai/ask`                  | Answers natural-language operational questions across store telemetry        |
