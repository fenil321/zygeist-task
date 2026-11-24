"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
} from "lucide-react";
import { apiFetch, fmtMoney, normalizeArray } from "@/lib/api";

function StatusBadge({ status }) {
  const s = String(status || "UNKNOWN").toUpperCase();
  if (s === "MATCHED" || s === "COMPLETED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" /> {s}
      </span>
    );
  }
  if (s === "MISMATCH" || s === "CANCELLED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700 border border-rose-200">
        <AlertTriangle className="h-3.5 w-3.5" /> {s}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
      <Clock className="h-3.5 w-3.5" /> {s}
    </span>
  );
}

function formatCheckMetric(c) {
  if (c.label || c.name || c.metric) return c.label || c.name || c.metric;
  if (c.deptName || c.dept_name || c.department) {
    const code = c.deptCode || c.dept_code;
    const name = c.deptName || c.dept_name || c.department;
    return code ? `${code} — ${name}` : name;
  }
  if (c.tenderType || c.tender_type || c.tender) {
    return c.tenderType || c.tender_type || c.tender;
  }
  if (c.deviceId || c.device_id || c.shiftId || c.shift_id) {
    const dev = c.deviceId || c.device_id || "";
    const shift = c.shiftId || c.shift_id || "";
    return [dev, shift].filter(Boolean).join(" · ");
  }
  return c.deptCode || c.dept_code || c.code || "Line Check";
}

export default function ReconciliationTab({ storeId, date, refreshKey }) {
  const [dashboard, setDashboard] = useState(null);
  const [reconciliation, setReconciliation] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [selectedTx, setSelectedTx] = useState(null);
  const [txFilter, setTxFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const [dashRes, recRes, txRes] = await Promise.all([
        apiFetch(`/api/dashboard?storeId=${storeId}&date=${date}`),
        apiFetch(`/api/reconciliation?storeId=${storeId}&date=${date}`),
        apiFetch(`/api/transactions?storeId=${storeId}&date=${date}&limit=100`),
      ]);
      setDashboard(dashRes);
      setReconciliation(recRes);
      setTransactions(normalizeArray(txRes, ["transactions", "rows", "items"]));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    setSelectedTx(null);
  }, [storeId, date, refreshKey]);

  async function inspectTransaction(id) {
    try {
      const detail = await apiFetch(`/api/transactions/${id}`);
      setSelectedTx(detail);
    } catch (err) {
      setError(err.message);
    }
  }

  const kpis =
    dashboard?.kpis ||
    dashboard?.summary ||
    dashboard?.daySummary ||
    dashboard ||
    {};
  const allChecks = reconciliation
    ? [
        ...(reconciliation.headlineChecks || []).map((c) => ({
          ...c,
          group: "Headline",
        })),
        ...(reconciliation.departmentChecks || []).map((c) => ({
          ...c,
          group: "Department",
        })),
        ...(reconciliation.tenderChecks || []).map((c) => ({
          ...c,
          group: "Tender",
        })),
        ...(reconciliation.internalConsistency || []).map((c) => ({
          ...c,
          group: "Consistency",
        })),
        ...(reconciliation.shiftCashChecks || []).map((c) => ({
          ...c,
          group: "Shift Cash",
        })),
      ]
    : [];

  const mismatchCount = allChecks.filter((c) => c.status !== "MATCHED").length;

  const filteredTx = transactions.filter((t) => {
    if (txFilter === "ALL") return true;
    if (txFilter === "REVIEW") return Boolean(t.needs_review || t.needsReview);
    if (txFilter === "EXCEPTIONS")
      return (
        t.status === "CANCELLED" ||
        ["REFUND", "NO_SALE", "CASH_DROP"].includes(t.tx_type)
      );
    return true;
  });

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-slate-500">
        Loading store telemetry for {storeId} on {date}...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Net Sales
          </div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            {fmtMoney(
              kpis.netSales ?? kpis.net_sales ?? kpis.totalNetSales ?? 0,
            )}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Kiosk: {fmtMoney(kpis.kioskSales ?? kpis.kiosk_sales ?? 0)} ·
            Counter: {fmtMoney(kpis.counterSales ?? kpis.counter_sales ?? 0)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Tax & Gift Card Loads
          </div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            {fmtMoney(
              kpis.taxCollected ?? kpis.tax_amount ?? kpis.totalTax ?? 0,
            )}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Gift Card Loads (Non-Revenue):{" "}
            {fmtMoney(kpis.giftCardLoads ?? kpis.gift_card_loads ?? 0)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Transactions
          </div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            {kpis.transactionCount ?? kpis.tx_count ?? transactions.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Store {storeId} · {date}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Reconciliation Status
          </div>
          <div className="mt-1 text-2xl font-bold text-slate-900">
            {allChecks.length - mismatchCount}/{allChecks.length} Matched
          </div>
          <div className="mt-1 text-xs text-amber-700 font-medium">
            {mismatchCount} discrepancy/review items flagged
          </div>
        </div>
      </div>

      {/* Reconciliation Audit Checks */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Reconciliation Engine (TLOG vs. Z-Report & Shift Cash)
            </h2>
            <p className="text-xs text-slate-500">
              Independent sum of POS events compared against end-of-day
              Z-reports
            </p>
          </div>
          <button
            onClick={loadData}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Re-verify
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-600">
              <tr>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Metric</th>
                <th className="px-4 py-3 text-right">TLOG Computed</th>
                <th className="px-4 py-3 text-right">Z-Report / Expected</th>
                <th className="px-4 py-3 text-right">Variance</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Explanation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {allChecks.map((c, idx) => (
                <tr
                  key={idx}
                  className={c.status !== "MATCHED" ? "bg-amber-50/40" : ""}
                >
                  <td className="px-4 py-2.5 text-xs font-medium text-slate-500">
                    {c.group}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-slate-900">
                    {formatCheckMetric(c)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {fmtMoney(c.tlogValue ?? c.computed ?? 0)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {fmtMoney(c.zReportValue ?? c.reported ?? c.expected ?? 0)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold text-slate-800">
                    {fmtMoney(c.difference ?? c.variance ?? 0)}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 max-w-md">
                    {c.explanation || c.reason || "—"}
                  </td>
                </tr>
              ))}
              {allChecks.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-6 text-center text-sm text-slate-500"
                  >
                    No reconciliation checks returned for {storeId} on {date}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Transaction Explorer */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              POS Transaction Log ({filteredTx.length})
            </h2>
            <p className="text-xs text-slate-500">
              Click any row to inspect line items, voids, and payment tenders
            </p>
          </div>
          <div className="flex gap-2">
            {[
              { id: "ALL", label: "All Events" },
              { id: "REVIEW", label: "Needs Review" },
              { id: "EXCEPTIONS", label: "Voids / Refunds / No-Sale" },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setTxFilter(f.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                  txFilter === f.id
                    ? "bg-emerald-700 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto max-h-96">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-600 sticky top-0">
              <tr>
                <th className="px-4 py-2.5">Seq</th>
                <th className="px-4 py-2.5">Device</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Net</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                <th className="px-4 py-2.5">Flags</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredTx.map((tx) => (
                <tr
                  key={tx.id || tx.seq}
                  onClick={() => tx.id && inspectTransaction(tx.id)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-4 py-2 font-mono text-xs font-semibold text-slate-800">
                    {tx.seq}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {tx.device_id}
                  </td>
                  <td className="px-4 py-2 text-xs font-medium">
                    {tx.tx_type}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={tx.status} />
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {fmtMoney(tx.net_amount)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs font-semibold">
                    {fmtMoney(tx.grand_total)}
                  </td>
                  <td className="px-4 py-2 text-xs text-amber-700">
                    {tx.needs_review
                      ? Array.isArray(tx.review_reasons)
                        ? tx.review_reasons.join(", ")
                        : "Needs Review"
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-emerald-700">
                    <Search className="inline h-3.5 w-3.5" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedTx && (
          <div className="border-t border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase text-slate-700">
                Transaction Detail — Seq #
                {selectedTx.transaction?.seq || selectedTx.seq}
              </span>
              <button
                onClick={() => setSelectedTx(null)}
                className="text-xs text-slate-500 hover:text-slate-800"
              >
                Close
              </button>
            </div>
            <pre className="max-h-56 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-emerald-300">
              {JSON.stringify(selectedTx, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
