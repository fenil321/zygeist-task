"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  FileSpreadsheet,
  LayoutDashboard,
  ShieldAlert,
  Store,
  Tags,
} from "lucide-react";
import { API_BASE } from "@/lib/api";
import ReconciliationTab from "@/components/ReconciliationTab";
import InvoiceWorkbenchTab from "@/components/InvoiceWorkbenchTab";
import PriceCatalogTab from "@/components/PriceCatalogTab";
import AiInsightsTab from "@/components/AiInsightsTab";
import AuditQuarantineTab from "@/components/AuditQuarantineTab";

const TABS = [
  {
    id: "reconciliation",
    label: "Sales & Reconciliation",
    icon: LayoutDashboard,
  },
  { id: "invoices", label: "AI Invoice Capture", icon: FileSpreadsheet },
  { id: "catalog", label: "Catalog & Price Sync", icon: Tags },
  { id: "ai", label: "Loss Prevention & AI Q&A", icon: ShieldAlert },
  { id: "audit", label: "Ingestion & Quarantine", icon: Activity },
];

export default function BrightleafDashboard() {
  const [activeTab, setActiveTab] = useState("reconciliation");
  const [storeId, setStoreId] = useState("BL01");
  const [date, setDate] = useState("2026-10-10");
  const [sseConnected, setSseConnected] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/events`);
    es.onopen = () => setSseConnected(true);
    es.onmessage = () => setRefreshKey((k) => k + 1);
    es.onerror = () => setSseConnected(false);
    return () => es.close();
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* Top Operations Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-20">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-700 text-white font-bold">
              <Store className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-slate-900">
                Brightleaf Market · Store Operations & Reconciliation
              </h1>
              <p className="text-xs text-slate-500">
                POS TLOG Ingestion · Z-Report Audit · Two-Way Hub Sync · Gemini
                AI
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                sseConnected
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${sseConnected ? "bg-emerald-500" : "bg-slate-400"}`}
              />
              {sseConnected ? "Hub Stream Live" : "API Connected"}
            </span>

            <select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800"
            >
              <option value="BL01">Store BL01 (Downtown)</option>
              <option value="BL02">Store BL02 (Westside)</option>
            </select>

            <input
              type="date"
              min="2026-10-01"
              max="2026-10-14"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800"
            />
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex gap-1 overflow-x-auto border-t border-slate-100">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold whitespace-nowrap transition-colors ${
                  active
                    ? "border-emerald-700 text-emerald-800"
                    : "border-transparent text-slate-600 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {activeTab === "reconciliation" && (
          <ReconciliationTab
            storeId={storeId}
            date={date}
            refreshKey={refreshKey}
          />
        )}
        {activeTab === "invoices" && (
          <InvoiceWorkbenchTab
            storeId={storeId}
            onSuccessNotify={() => setRefreshKey((k) => k + 1)}
          />
        )}
        {activeTab === "catalog" && (
          <PriceCatalogTab storeId={storeId} refreshKey={refreshKey} />
        )}
        {activeTab === "ai" && <AiInsightsTab storeId={storeId} date={date} />}
        {activeTab === "audit" && (
          <AuditQuarantineTab refreshKey={refreshKey} />
        )}
      </main>
    </div>
  );
}
