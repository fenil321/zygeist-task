"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { apiFetch, fmtMoney, normalizeArray } from "@/lib/api";

export default function PriceCatalogTab({ storeId, refreshKey }) {
  const [items, setItems] = useState([]);
  const [batches, setBatches] = useState([]);
  const [search, setSearch] = useState("");
  const [draftPrices, setDraftPrices] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadCatalogAndBatches() {
    setError("");
    try {
      const [itemsRes, batchRes] = await Promise.all([
        apiFetch(
          `/api/items?storeId=${storeId}&search=${encodeURIComponent(search)}`,
        ),
        apiFetch(`/api/prices/changes?storeId=${storeId}`),
      ]);
      setItems(normalizeArray(itemsRes, ["items", "rows"]));
      setBatches(normalizeArray(batchRes, ["changes", "batches", "rows"]));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadCatalogAndBatches();
  }, [storeId, refreshKey]);

  async function pushSinglePriceChange(item, action = "update") {
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const newPrice = draftPrices[item.item_code] ?? item.price;
      const changeId = `PC-${storeId}-${Date.now().toString().slice(-5)}`;
      await apiFetch("/api/prices/changes", {
        method: "POST",
        body: JSON.stringify({
          storeId,
          changeId,
          items: [
            {
              action,
              itemCode: item.item_code,
              variant: item.variant || "000",
              oldPrice: String(item.price),
              newPrice: Number(newPrice).toFixed(2),
            },
          ],
        }),
      });
      setMessage(
        `Queued batch ${changeId} (${action.toUpperCase()} ${item.item_code} -> $${Number(newPrice).toFixed(2)}) in Hub inbox.`,
      );
      await loadCatalogAndBatches();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      )}

      {/* Hub Price Batch Acknowledgments */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Hub Price Change Batches & Acknowledgments
            </h3>
            <p className="text-xs text-slate-500">
              Tracks outbound inbox/ files and inbound outbox/ ACK results
            </p>
          </div>
          <button
            onClick={loadCatalogAndBatches}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh Status
          </button>
        </div>

        <div className="overflow-x-auto max-h-64">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-left font-semibold uppercase text-slate-600">
              <tr>
                <th className="px-4 py-2.5">Change ID</th>
                <th className="px-4 py-2.5">Store</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Details / Hub Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map((b, i) => (
                <tr key={b.change_id || b.id || i}>
                  <td className="px-4 py-2 font-mono font-semibold text-slate-800">
                    {b.change_id || b.changeId}
                  </td>
                  <td className="px-4 py-2">{b.store_id || b.storeId}</td>
                  <td className="px-4 py-2">
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-semibold text-slate-800">
                      {b.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {b.ack_message ||
                      b.error_reason ||
                      JSON.stringify(b.summary || "")}
                  </td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-5 text-center text-slate-500"
                  >
                    No price batches dispatched yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Store Catalog Search & Inline Update */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Store {storeId} Item Master ({items.length})
          </h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              loadCatalogAndBatches();
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              placeholder="Search SKU or description..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
            />
            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Search
            </button>
          </form>
        </div>

        <div className="overflow-x-auto max-h-96">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-left font-semibold uppercase text-slate-600 sticky top-0">
              <tr>
                <th className="px-4 py-2.5">Item Code</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5">Dept</th>
                <th className="px-4 py-2.5 text-right">Current Price</th>
                <th className="px-4 py-2.5 text-right">New Price ($)</th>
                <th className="px-4 py-2.5 text-right">Hub Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.slice(0, 80).map((item) => (
                <tr key={`${item.item_code}-${item.variant}`}>
                  <td className="px-4 py-2 font-mono font-medium">
                    {item.item_code}
                  </td>
                  <td className="px-4 py-2 text-slate-800">
                    {item.description}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{item.dept_code}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {fmtMoney(item.price)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <input
                      type="number"
                      step="0.01"
                      defaultValue={item.price}
                      onChange={(e) =>
                        setDraftPrices((prev) => ({
                          ...prev,
                          [item.item_code]: e.target.value,
                        }))
                      }
                      className="w-24 rounded border border-slate-300 px-2 py-1 text-right font-mono"
                    />
                  </td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <button
                      disabled={submitting}
                      onClick={() => pushSinglePriceChange(item, "update")}
                      className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2.5 py-1 font-semibold text-white hover:bg-emerald-800"
                    >
                      <Send className="h-3 w-3" /> Push Update
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
