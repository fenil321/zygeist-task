"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Loader2,
  Send,
} from "lucide-react";
import { apiFetch, fmtMoney, normalizeArray } from "@/lib/api";

export default function InvoiceWorkbenchTab({ storeId, onSuccessNotify }) {
  const [file, setFile] = useState(null);
  const [targetMargin, setTargetMargin] = useState(35);
  const [uploading, setUploading] = useState(false);
  const [approving, setApproving] = useState(false);

  const [invoices, setInvoices] = useState([]);
  const [activeInvoice, setActiveInvoice] = useState(null);
  const [editableLines, setEditableLines] = useState([]);
  const [banner, setBanner] = useState(null);
  const [error, setError] = useState("");

  async function loadInvoices() {
    try {
      const res = await apiFetch("/api/ai/invoices");
      setInvoices(normalizeArray(res, ["invoices", "rows"]));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadInvoices();
  }, []);

  async function selectInvoice(id) {
    setError("");
    setBanner(null);
    try {
      const detail = await apiFetch(`/api/ai/invoices/${id}`);
      const inv = detail.invoice || detail;
      const lines = detail.lines || [];
      setActiveInvoice(inv);
      setEditableLines(lines.map((l) => ({ ...l })));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError("");
    setBanner(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("storeId", storeId);
      form.append("targetMargin", String(targetMargin));

      const res = await apiFetch("/api/ai/invoices/extract", {
        method: "POST",
        body: form,
      });

      const inv = res.invoice || res.data?.invoice;
      const lines = res.lines || res.data?.lines || [];
      setActiveInvoice(inv);
      setEditableLines(lines.map((l) => ({ ...l })));
      setFile(null);
      await loadInvoices();
      setBanner(
        `Extracted ${lines.length} line items from ${inv.supplier_name || "supplier invoice"}.`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function updateLine(idx, field, value) {
    setEditableLines((prev) =>
      prev.map((line, i) => (i === idx ? { ...line, [field]: value } : line)),
    );
  }

  async function handleApproveAndPush() {
    if (!activeInvoice) return;
    setApproving(true);
    setError("");
    try {
      const result = await apiFetch(
        `/api/ai/invoices/${activeInvoice.id}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            pushToHub: true,
            linesOverride: editableLines.map((l) => ({
              id: l.id,
              approved_retail_price: l.approved_retail_price,
              matched_item_code: l.matched_item_code,
              matched_variant: l.matched_variant,
              suggested_action: l.suggested_action,
              proposed_dept_code: l.proposed_dept_code,
              proposed_tax_group: l.proposed_tax_group,
              include_in_sync: l.include_in_sync,
            })),
          }),
        },
      );

      setBanner(
        `Approved invoice #${activeInvoice.invoice_number} and pushed ${result.pushedItemCount} price updates to Hub (${result.changeId || "batch queued"}).`,
      );
      await loadInvoices();
      await selectInvoice(activeInvoice.id);
      if (onSuccessNotify) onSuccessNotify();
    } catch (err) {
      setError(err.message);
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Upload Card */}
      <form
        onSubmit={handleUpload}
        className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm flex flex-wrap items-end justify-between gap-4"
      >
        <div className="flex-1 min-w-[260px]">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1.5">
            Upload Supplier Invoice (PDF, PNG, JPG) — Target Store: {storeId}
          </label>
          <input
            type="file"
            accept=".pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm text-slate-700 file:mr-4 file:rounded-lg file:border-0 file:bg-emerald-50 file:px-4 file:py-2 file:text-xs file:font-semibold file:text-emerald-700 hover:file:bg-emerald-100"
          />
        </div>

        <div className="w-36">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1.5">
            Target Margin %
          </label>
          <input
            type="number"
            min="5"
            max="80"
            value={targetMargin}
            onChange={(e) => setTargetMargin(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          disabled={!file || uploading}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileUp className="h-4 w-4" />
          )}
          {uploading ? "Extracting with Gemini..." : "Extract & Match Catalog"}
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {banner && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> {banner}
        </div>
      )}

      {/* Active Invoice Review Workbench */}
      {activeInvoice && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
            <div>
              <div className="flex items-center gap-2.5">
                <h3 className="text-base font-bold text-slate-900">
                  {activeInvoice.supplier_name || "Unknown Supplier"} — #
                  {activeInvoice.invoice_number}
                </h3>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    activeInvoice.status === "APPROVED"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {activeInvoice.status}
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-0.5">
                Date: {activeInvoice.invoice_date} · Subtotal:{" "}
                {fmtMoney(activeInvoice.subtotal)} · Tax:{" "}
                {fmtMoney(activeInvoice.tax_amount)} · Fees:{" "}
                {fmtMoney(activeInvoice.shipping_or_fees)} ·{" "}
                <strong className="text-slate-900">
                  Total: {fmtMoney(activeInvoice.total_amount)}
                </strong>
              </p>
            </div>

            <button
              onClick={handleApproveAndPush}
              disabled={approving}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {approving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Approve & Push Price Batch to Hub
            </button>
          </div>

          {/* Discrepancies & Extraction Notes */}
          {((activeInvoice.discrepancies &&
            activeInvoice.discrepancies.length > 0) ||
            (activeInvoice.extraction_notes &&
              activeInvoice.extraction_notes.length > 0)) && (
            <div className="border-b border-amber-200 bg-amber-50 px-5 py-3 space-y-1">
              {(activeInvoice.discrepancies || []).map((d, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-xs font-medium text-rose-800"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />{" "}
                  {d}
                </div>
              ))}
              {(activeInvoice.extraction_notes || []).map((n, i) => (
                <div key={i} className="text-xs text-amber-900">
                  <strong>Note:</strong> {n}
                </div>
              ))}
            </div>
          )}

          {/* Editable Line Items Table */}
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2.5">Sync</th>
                  <th className="px-3 py-2.5">Action</th>
                  <th className="px-3 py-2.5">SKU / Item Code</th>
                  <th className="px-3 py-2.5">Invoice Description</th>
                  <th className="px-3 py-2.5 text-right">Qty</th>
                  <th className="px-3 py-2.5 text-right">Unit Cost</th>
                  <th className="px-3 py-2.5 text-right">Line Total</th>
                  <th className="px-3 py-2.5 text-right">Curr. Retail</th>
                  <th className="px-3 py-2.5 text-right">
                    Approved Retail ($)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {editableLines.map((line, idx) => (
                  <tr
                    key={line.id || idx}
                    className={line.math_mismatch ? "bg-rose-50/60" : ""}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={Boolean(line.include_in_sync)}
                        onChange={(e) =>
                          updateLine(idx, "include_in_sync", e.target.checked)
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={line.suggested_action || "update"}
                        onChange={(e) =>
                          updateLine(idx, "suggested_action", e.target.value)
                        }
                        className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                      >
                        <option value="update">UPDATE</option>
                        <option value="add">ADD NEW</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={line.matched_item_code || ""}
                        onChange={(e) =>
                          updateLine(idx, "matched_item_code", e.target.value)
                        }
                        className="w-32 rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">
                        {line.description}
                      </div>
                      {line.matched_description && (
                        <div className="text-[11px] text-emerald-700">
                          Matched: {line.matched_description} (
                          {Math.round((line.match_score || 0) * 100)}%)
                        </div>
                      )}
                      {line.math_note && (
                        <div className="text-[11px] text-rose-700">
                          {line.math_note}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {Number(line.quantity)} {line.unit_of_measure}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {fmtMoney(line.unit_cost)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {fmtMoney(line.line_total)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500">
                      {line.current_retail_price
                        ? fmtMoney(line.current_retail_price)
                        : "NEW"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        step="0.01"
                        value={line.approved_retail_price ?? ""}
                        onChange={(e) =>
                          updateLine(
                            idx,
                            "approved_retail_price",
                            e.target.value,
                          )
                        }
                        className="w-24 rounded border border-slate-300 px-2 py-1 text-right font-mono text-xs font-semibold"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Processed Invoices History */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">
            Captured Supplier Invoices ({invoices.length})
          </h3>
        </div>
        <div className="divide-y divide-slate-100">
          {invoices.map((inv) => (
            <div
              key={inv.id}
              onClick={() => selectInvoice(inv.id)}
              className="flex cursor-pointer items-center justify-between px-5 py-3 hover:bg-slate-50"
            >
              <div>
                <div className="text-sm font-medium text-slate-900">
                  {inv.supplier_name} · #{inv.invoice_number} (
                  {inv.source_filename})
                </div>
                <div className="text-xs text-slate-500">
                  Store {inv.store_id} · Date {inv.invoice_date} · Math Valid:{" "}
                  {String(inv.math_valid)}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-semibold">
                  {fmtMoney(inv.total_amount)}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    inv.status === "APPROVED"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {inv.status}
                </span>
              </div>
            </div>
          ))}
          {invoices.length === 0 && (
            <div className="px-5 py-6 text-center text-xs text-slate-500">
              No invoices uploaded yet. Upload any PDF or image from
              data_package/invoices above.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
