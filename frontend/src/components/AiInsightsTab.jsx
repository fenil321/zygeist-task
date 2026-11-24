"use client";

import { useState } from "react";
import { Loader2, MessageSquare, ShieldAlert, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";

const SAMPLE_QUESTIONS = [
  "Compare BL01 and BL02 net sales across the 14 days and highlight any void or quarantine anomalies.",
  "Which staff members had the highest cancelled transactions, voids, or no-sale drawer openings?",
  "What are the top 5 selling items and departments in BL01 vs BL02?",
];

export default function AiInsightsTab({ storeId, date }) {
  const [lpData, setLpData] = useState(null);
  const [lpLoading, setLpLoading] = useState(false);

  const [question, setQuestion] = useState(SAMPLE_QUESTIONS[0]);
  const [scopeStore, setScopeStore] = useState("ALL");
  const [qaResult, setQaResult] = useState(null);
  const [qaLoading, setQaLoading] = useState(false);
  const [error, setError] = useState("");

  async function runLossPrevention() {
    setLpLoading(true);
    setError("");
    try {
      const res = await apiFetch(
        `/api/ai/loss-prevention?storeId=${storeId}&date=${date}`,
      );
      setLpData(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLpLoading(false);
    }
  }

  async function handleAsk(e) {
    e.preventDefault();
    if (!question.trim()) return;
    setQaLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/ai/ask", {
        method: "POST",
        body: JSON.stringify({
          question,
          storeId: scopeStore === "ALL" ? null : scopeStore,
          dateFrom: "2026-10-01",
          dateTo: "2026-10-14",
        }),
      });
      setQaResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setQaLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {error && (
        <div className="lg:col-span-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Module 5C: Daily Loss-Prevention & Exception Summary */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between gap-2 pb-4 border-b border-slate-200">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-rose-600" />{" "}
                Loss-Prevention Audit
              </h3>
              <p className="text-xs text-slate-500">
                Grounded exception analysis for {storeId} on {date}
              </p>
            </div>
            <button
              onClick={runLossPrevention}
              disabled={lpLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-800 disabled:opacity-50"
            >
              {lpLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Generate Risk Brief
            </button>
          </div>

          {lpData ? (
            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 border border-slate-200">
                <div className="text-xs text-slate-600">
                  Exceptions:{" "}
                  <strong>{lpData.metrics?.exceptionEventCount}</strong> · Rec
                  Mismatches:{" "}
                  <strong>{lpData.metrics?.reconciliationMismatchCount}</strong>{" "}
                  · Quarantined:{" "}
                  <strong>{lpData.metrics?.quarantinedFileCount}</strong>
                </div>
                <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-800">
                  RISK: {lpData.report?.risk_level}
                </span>
              </div>

              <p className="text-sm text-slate-700 leading-relaxed">
                {lpData.report?.executive_summary}
              </p>

              <div className="space-y-3">
                {(lpData.report?.findings || []).map((f, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-slate-200 p-3.5 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-900">
                        {f.title}
                      </span>
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                        {f.severity} · Impact: ${f.dollar_impact}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      {f.recommended_action}
                    </p>
                    <div className="text-[11px] font-mono text-slate-500">
                      Citations: {(f.evidence_citations || []).join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="py-12 text-center text-xs text-slate-500">
              Click <strong>Generate Risk Brief</strong> to audit voids,
              unreferenced refunds, no-sale drawer openings, and quarantined
              batches.
            </div>
          )}
        </div>
      </div>

      {/* Module 5B: Ask Your Stores */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="pb-4 border-b border-slate-200">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-emerald-700" /> Ask Your
            Stores (AI Operations Analyst)
          </h3>
          <p className="text-xs text-slate-500">
            Grounded in verified PostgreSQL sales, catalog, tender, and
            exception records
          </p>
        </div>

        <form onSubmit={handleAsk} className="mt-4 space-y-3">
          <div className="flex gap-2">
            <select
              value={scopeStore}
              onChange={(e) => setScopeStore(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium"
            >
              <option value="ALL">All Stores (BL01 + BL02)</option>
              <option value="BL01">Store BL01 Only</option>
              <option value="BL02">Store BL02 Only</option>
            </select>
          </div>

          <textarea
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question about store sales, departments, voids, or anomalies..."
            className="w-full rounded-lg border border-slate-300 p-3 text-sm"
          />

          <div className="flex flex-wrap gap-1.5">
            {SAMPLE_QUESTIONS.map((sq, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setQuestion(sq)}
                className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-700 hover:bg-slate-200 text-left"
              >
                {sq.slice(0, 58)}...
              </button>
            ))}
          </div>

          <button
            type="submit"
            disabled={qaLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {qaLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Ask Analyst
          </button>
        </form>

        {qaResult && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
            <div className="text-[11px] font-semibold uppercase text-emerald-800 mb-2">
              Scope: {qaResult.scope?.storeId} ({qaResult.scope?.dateFrom} to{" "}
              {qaResult.scope?.dateTo})
            </div>
            <div className="whitespace-pre-wrap text-sm text-slate-800 leading-relaxed">
              {qaResult.answer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
