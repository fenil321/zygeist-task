'use client';

import { useEffect, useState } from 'react';
import { AlertOctagon, Building2, FileCheck2 } from 'lucide-react';
import { apiFetch, fmtMoney, normalizeArray } from '@/lib/api';

function extractFirstArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const found = Object.values(payload).find((v) => Array.isArray(v));
  return found || [];
}

function extractIngestedArray(auditData) {
  if (Array.isArray(auditData)) return auditData;
  if (!auditData || typeof auditData !== 'object') return [];
  const quarantinedKeys = new Set(['quarantined', 'quarantinedFiles', 'quarantined_files', 'errors']);
  const entry = Object.entries(auditData).find(
    ([key, val]) => !quarantinedKeys.has(key) && Array.isArray(val)
  );
  return entry ? entry[1] : [];
}

export default function AuditQuarantineTab({ refreshKey }) {
  const [auditData, setAuditData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [auditRes, acctRes] = await Promise.all([
          apiFetch('/api/audit'),
          apiFetch('/api/business-accounts'),
        ]);
        setAuditData(auditRes);
        setAccounts(extractFirstArray(acctRes));
      } catch (err) {
        setError(err.message);
      }
    }
    load();
  }, [refreshKey]);

  const quarantined = normalizeArray(auditData, [
    'quarantined',
    'quarantinedFiles',
    'quarantined_files',
    'errors',
  ]);
  const ingested = extractIngestedArray(auditData);

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

      {/* Quarantined Files */}
      <div className="rounded-xl border border-rose-200 bg-white shadow-sm">
        <div className="border-b border-rose-100 bg-rose-50/70 px-5 py-3.5 flex items-center gap-2">
          <AlertOctagon className="h-5 w-5 text-rose-600" />
          <div>
            <h3 className="text-sm font-bold text-rose-950">Quarantined Files ({quarantined.length})</h3>
            <p className="text-xs text-rose-700">Malformed POS files isolated without crashing batch ingestion</p>
          </div>
        </div>
        <div className="divide-y divide-slate-100">
          {quarantined.map((q, i) => (
            <div key={i} className="px-5 py-3 text-xs">
              <div className="font-mono font-bold text-slate-900">
                [{q.store_id || q.storeId || 'STORE'}] {q.filename}
              </div>
              <div className="mt-1 text-rose-700">{q.error_reason || q.errorReason || q.reason}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Business House Accounts */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-3.5 flex items-center gap-2">
          <Building2 className="h-5 w-5 text-slate-700" />
          <h3 className="text-sm font-semibold text-slate-900">Business House Accounts ({accounts.length})</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-left font-semibold uppercase text-slate-600">
              <tr>
                <th className="px-4 py-2.5">Account ID</th>
                <th className="px-4 py-2.5">Business Name</th>
                <th className="px-4 py-2.5 text-right">Credit Limit</th>
                <th className="px-4 py-2.5 text-right">Current Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {accounts.map((a, i) => (
                <tr key={a.account_id || a.accountId || i}>
                  <td className="px-4 py-2 font-mono font-semibold">{a.account_id || a.accountId}</td>
                  <td className="px-4 py-2">{a.business_name || a.name || a.businessName}</td>
                  <td className="px-4 py-2 text-right font-mono">{fmtMoney(a.credit_limit ?? a.creditLimit ?? 0)}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold">
                    {fmtMoney(a.current_balance ?? a.balance ?? a.currentBalance ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Imported Files Log */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-3.5 flex items-center gap-2">
          <FileCheck2 className="h-5 w-5 text-emerald-700" />
          <h3 className="text-sm font-semibold text-slate-900">Ingested File Audit Trail ({ingested.length})</h3>
        </div>
        <div className="overflow-x-auto max-h-80">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-left font-semibold uppercase text-slate-600 sticky top-0">
              <tr>
                <th className="px-4 py-2">Filename</th>
                <th className="px-4 py-2">Store</th>
                <th className="px-4 py-2">Format / Type</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ingested.map((f, i) => (
                <tr key={f.id || f.filename || i}>
                  <td className="px-4 py-2 font-mono">{f.filename || f.file_name}</td>
                  <td className="px-4 py-2">{f.store_id || f.storeId || '—'}</td>
                  <td className="px-4 py-2">{f.file_type || f.fileType || f.format || 'POS'}</td>
                  <td className="px-4 py-2 text-emerald-700 font-medium">{f.status || 'IMPORTED'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}