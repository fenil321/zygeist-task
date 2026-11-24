import Decimal from 'decimal.js';
import { pool } from '../db.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

function d(val) {
  return new Decimal(val || 0);
}

function fmt(dec) {
  return dec.toFixed(2);
}

export async function reconcileStoreDay(storeId, businessDate) {
  const client = await pool.connect();
  try {
    // 1. Fetch EOD summary, Shift summaries, Quarantined files, and Flagged tx counts
    const eodRes = await client.query(
      'SELECT * FROM eod_summaries WHERE store_id = $1 AND business_date = $2',
      [storeId, businessDate]
    );
    const eod = eodRes.rows[0] || null;

    const shiftRes = await client.query(
      'SELECT * FROM shift_summaries WHERE store_id = $1 AND business_date = $2 ORDER BY shift_no',
      [storeId, businessDate]
    );

    const quarRes = await client.query(
      `SELECT filename, error_reason FROM quarantined_files
       WHERE (store_id = $1 OR store_id IS NULL)`,
      [storeId]
    );

    const flaggedRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM transactions
       WHERE store_id = $1 AND business_date = $2 AND needs_review = TRUE`,
      [storeId, businessDate]
    );
    const flaggedTxCount = flaggedRes.rows[0]?.cnt || 0;

    // 2. Recompute Department Sales from ACTIVE item lines on COMPLETED SALE/REFUND tx
    const deptRows = await client.query(
      `SELECT COALESCE(tl.dept_code, 'UNASSIGNED') AS dept_code,
              COALESCE(dept.name, 'Dept ' || COALESCE(tl.dept_code, 'Unknown')) AS dept_name,
              SUM(tl.amount) AS computed_amount,
              SUM(tl.qty) AS computed_qty
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       LEFT JOIN departments dept ON dept.dept_code = tl.dept_code
       WHERE t.store_id = $1
         AND t.business_date = $2
         AND t.status = 'COMPLETED'
         AND t.tx_type IN ('SALE', 'REFUND')
         AND tl.line_type = 'ITEM'
         AND tl.status = 'ACTIVE'
       GROUP BY 1, 2
       ORDER BY 1`,
      [storeId, businessDate]
    );

    // 3. Recompute Tenders from COMPLETED SALE/REFUND transactions
    const tenderRows = await client.query(
      `SELECT tp.tender_type AS method,
              COUNT(*)::int AS computed_count,
              SUM(tp.amount) AS computed_amount
       FROM transaction_tenders tp
       JOIN transactions t ON t.id = tp.transaction_id
       WHERE t.store_id = $1
         AND t.business_date = $2
         AND t.status = 'COMPLETED'
         AND t.tx_type IN ('SALE', 'REFUND')
       GROUP BY 1
       ORDER BY 1`,
      [storeId, businessDate]
    );

    // 4. Recompute Taxes per Tax Group from COMPLETED SALE/REFUND transactions
    const taxRows = await client.query(
      `SELECT tt.tax_group,
              SUM(tt.taxable_amount) AS computed_taxable,
              SUM(tt.tax_amount) AS computed_tax
       FROM transaction_taxes tt
       JOIN transactions t ON t.id = tt.transaction_id
       WHERE t.store_id = $1
         AND t.business_date = $2
         AND t.status = 'COMPLETED'
         AND t.tx_type IN ('SALE', 'REFUND')
       GROUP BY 1
       ORDER BY 1`,
      [storeId, businessDate]
    );

    // 5. Recompute Gift Card Loads (not sales, not taxed, part of grand total)
    const gcRes = await client.query(
      `SELECT COUNT(*)::int AS load_count,
              COALESCE(SUM(tl.amount), 0) AS computed_loads
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE t.store_id = $1
         AND t.business_date = $2
         AND t.status = 'COMPLETED'
         AND tl.line_type = 'GIFT_CARD_LOAD'
         AND tl.status = 'ACTIVE'`,
      [storeId, businessDate]
    );

    // 6. Gather diagnostic totals (voided lines, cancelled txs, cancelled cash drops)
    const diagRes = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tl.status = 'VOID' AND t.status = 'COMPLETED' THEN tl.amount ELSE 0 END), 0) AS voided_lines_amt,
         COALESCE(SUM(CASE WHEN t.status = 'CANCELLED' AND tl.line_type = 'ITEM' AND tl.status = 'ACTIVE' THEN tl.amount ELSE 0 END), 0) AS cancelled_tx_amt
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE t.store_id = $1 AND t.business_date = $2`,
      [storeId, businessDate]
    );
    const voidedLinesAmt = d(diagRes.rows[0]?.voided_lines_amt);
    const cancelledTxAmt = d(diagRes.rows[0]?.cancelled_tx_amt);

    const txCountRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM transactions
       WHERE store_id = $1 AND business_date = $2
         AND status = 'COMPLETED' AND tx_type IN ('SALE', 'REFUND')`,
      [storeId, businessDate]
    );
    const computedTxCount = txCountRes.rows[0]?.cnt || 0;

    // Aggregate computed headlines
    const computedNetSales = deptRows.rows.reduce((acc, r) => acc.plus(d(r.computed_amount)), d(0));
    const computedTax = taxRows.rows.reduce((acc, r) => acc.plus(d(r.computed_tax)), d(0));
    const computedGcLoads = d(gcRes.rows[0]?.computed_loads);
    const computedGrandTotal = computedNetSales.plus(computedTax).plus(computedGcLoads);

    const hasMissingOrFlagged = !eod || flaggedTxCount > 0 || quarRes.rowCount > 0;
    const eodPayload = eod?.raw_payload || {};

    // Helper to build status & root-cause hint
    const evaluateLine = (label, computedDec, reportedDec, context = {}) => {
      if (reportedDec === null || reportedDec === undefined) {
        return {
          status: 'REVIEW_REQUIRED',
          difference: null,
          explanation: 'Hub EOD summary file not yet received for this store and business date.',
        };
      }
      const diff = computedDec.minus(reportedDec); // positive = computed > reported
      if (diff.isZero()) {
        if (flaggedTxCount > 0 || quarRes.rowCount > 0) {
          return {
            status: 'REVIEW_REQUIRED',
            difference: '0.00',
            explanation: `Totals match, but ${flaggedTxCount} flagged transaction(s) and ${quarRes.rowCount} quarantined file(s) exist.`,
          };
        }
        return { status: 'MATCHED', difference: '0.00', explanation: null };
      }

      const absDiff = diff.abs();
      let hint = `${label} differs by $${fmt(diff)} (Computed $${fmt(computedDec)} vs Hub $${fmt(reportedDec)}).`;

      if (!voidedLinesAmt.isZero() && absDiff.equals(voidedLinesAmt.abs())) {
        hint += ` Exact match to voided item lines ($${fmt(voidedLinesAmt)}) — one side included voided lines in totals.`;
      } else if (!cancelledTxAmt.isZero() && absDiff.equals(cancelledTxAmt.abs())) {
        hint += ` Exact match to cancelled transaction items ($${fmt(cancelledTxAmt)}) — one side counted abandoned transactions.`;
      } else if (!computedGcLoads.isZero() && absDiff.equals(computedGcLoads.abs())) {
        hint += ` Exact match to Gift Card Loads ($${fmt(computedGcLoads)}) — gift card loads were treated as net sales instead of liabilities.`;
      } else if (context.cancelledDrops && absDiff.equals(context.cancelledDrops.abs())) {
        hint += ` Exact match to cancelled cash drops ($${fmt(context.cancelledDrops)}) — hub subtracted an uncompleted drop.`;
      } else if (quarRes.rowCount > 0) {
        hint += ` Likely caused by quarantined/corrupted file(s) (${quarRes.rows.map((q) => q.filename).join(', ')}) missing from computed logs.`;
      } else if (diff.isNegative()) {
        hint += ` Hub reported $${fmt(absDiff)} more than ingested TLOGs (check for late/missing batch files).`;
      } else {
        hint += ` Ingested TLOGs exceed hub summary by $${fmt(absDiff)}.`;
      }

      return {
        status: 'MISMATCH',
        difference: fmt(diff),
        explanation: hint,
      };
    };

    // 7. Build Department comparisons
    const reportedDeptMap = new Map(
      (eodPayload.departments || []).map((dep) => [dep.deptCode, d(dep.amount)])
    );
    const computedDeptMap = new Map(
      deptRows.rows.map((r) => [r.dept_code, { name: r.dept_name, amount: d(r.computed_amount) }])
    );
    const allDeptCodes = [...new Set([...computedDeptMap.keys(), ...reportedDeptMap.keys()])].sort();

    const departmentChecks = allDeptCodes.map((code) => {
      const comp = computedDeptMap.get(code)?.amount || d(0);
      const rep = eod ? reportedDeptMap.get(code) || d(0) : null;
      const evalRes = evaluateLine(`Department ${code}`, comp, rep);
      return {
        deptCode: code,
        deptName: computedDeptMap.get(code)?.name || `Dept ${code}`,
        computed: fmt(comp),
        reported: rep ? fmt(rep) : null,
        ...evalRes,
      };
    });

    // 8. Build Tender comparisons
    const reportedTenderMap = new Map(
      (eodPayload.payments || []).map((p) => [p.method.toUpperCase(), d(p.amount)])
    );
    const computedTenderMap = new Map(
      tenderRows.rows.map((r) => [r.method.toUpperCase(), d(r.computed_amount)])
    );
    const allMethods = [...new Set([...computedTenderMap.keys(), ...reportedTenderMap.keys()])].sort();

    const tenderChecks = allMethods.map((method) => {
      const comp = computedTenderMap.get(method) || d(0);
      const rep = eod ? reportedTenderMap.get(method) || d(0) : null;
      const evalRes = evaluateLine(`Tender ${method}`, comp, rep);
      return {
        method,
        computed: fmt(comp),
        reported: rep ? fmt(rep) : null,
        ...evalRes,
      };
    });

    // 9. Build Tax & Gift Card comparisons
    const reportedTaxTotal = eod ? d(eod.reported_tax) : null;
    const taxCheck = {
      label: 'Total Tax',
      computed: fmt(computedTax),
      reported: reportedTaxTotal ? fmt(reportedTaxTotal) : null,
      ...evaluateLine('Total Tax', computedTax, reportedTaxTotal),
    };

    const reportedGcTotal = eod ? d(eod.reported_gc_loads) : null;
    const giftCardCheck = {
      label: 'Gift Card Loads',
      computed: fmt(computedGcLoads),
      reported: reportedGcTotal ? fmt(reportedGcTotal) : null,
      ...evaluateLine('Gift Card Loads', computedGcLoads, reportedGcTotal),
    };

    const headlineChecks = [
      {
        label: 'Net Sales',
        computed: fmt(computedNetSales),
        reported: eod ? fmt(d(eod.reported_net_sales)) : null,
        ...evaluateLine('Net Sales', computedNetSales, eod ? d(eod.reported_net_sales) : null),
      },
      taxCheck,
      giftCardCheck,
      {
        label: 'Grand Total',
        computed: fmt(computedGrandTotal),
        reported: eod ? fmt(d(eod.reported_grand_total)) : null,
        ...evaluateLine('Grand Total', computedGrandTotal, eod ? d(eod.reported_grand_total) : null),
      },
    ];

    // 10. Hub EOD Internal Self-Consistency Checks
    const internalConsistency = [];
    if (eod) {
      const hubDeptSum = (eodPayload.departments || []).reduce((acc, x) => acc.plus(d(x.amount)), d(0));
      const hubNet = d(eod.reported_net_sales);
      const deptSelfDiff = hubDeptSum.minus(hubNet);
      internalConsistency.push({
        check: 'Hub Department Sum vs. Hub Reported Net Sales',
        expected: fmt(hubNet),
        actual: fmt(hubDeptSum),
        status: deptSelfDiff.isZero() ? 'MATCHED' : 'MISMATCH',
        difference: fmt(deptSelfDiff),
        explanation: deptSelfDiff.isZero()
          ? null
          : `Hub's own department lines sum to $${fmt(hubDeptSum)}, which disagrees with its stated net sales of $${fmt(hubNet)} by $${fmt(deptSelfDiff)}.`,
      });

      const hubFormulaGrand = hubNet.plus(d(eod.reported_tax)).plus(d(eod.reported_gc_loads));
      const hubStatedGrand = d(eod.reported_grand_total);
      const grandSelfDiff = hubFormulaGrand.minus(hubStatedGrand);
      internalConsistency.push({
        check: 'Hub (Net + Tax + Gift Card Loads) vs. Hub Grand Total',
        expected: fmt(hubStatedGrand),
        actual: fmt(hubFormulaGrand),
        status: grandSelfDiff.isZero() ? 'MATCHED' : 'MISMATCH',
        difference: fmt(grandSelfDiff),
        explanation: grandSelfDiff.isZero()
          ? null
          : `Hub components add up to $${fmt(hubFormulaGrand)} vs stated Grand Total $${fmt(hubStatedGrand)} (diff $${fmt(grandSelfDiff)}).`,
      });

      const hubTenderSum = (eodPayload.payments || []).reduce((acc, x) => acc.plus(d(x.amount)), d(0));
      const tenderSelfDiff = hubTenderSum.minus(hubStatedGrand);
      internalConsistency.push({
        check: 'Hub Payment Tenders Sum vs. Hub Grand Total',
        expected: fmt(hubStatedGrand),
        actual: fmt(hubTenderSum),
        status: tenderSelfDiff.isZero() ? 'MATCHED' : 'MISMATCH',
        difference: fmt(tenderSelfDiff),
        explanation: tenderSelfDiff.isZero()
          ? null
          : `Hub payment tenders sum to $${fmt(hubTenderSum)} vs stated Grand Total $${fmt(hubStatedGrand)} (diff $${fmt(tenderSelfDiff)}).`,
      });
    }

    // 11. Shift Cash Reconciliation: openingFloat + netCashTenders - completedCashDrops vs countedCash
    const shiftCashChecks = [];
    for (const sh of shiftRes.rows) {
      const cashTenderRes = await client.query(
        `SELECT COALESCE(SUM(tp.amount), 0) AS net_cash
         FROM transaction_tenders tp
         JOIN transactions t ON t.id = tp.transaction_id
         WHERE t.store_id = $1 AND t.business_date = $2 AND t.shift_no = $3
           AND t.status = 'COMPLETED' AND t.tx_type IN ('SALE', 'REFUND')
           AND tp.tender_type = 'CASH'`,
        [storeId, businessDate, sh.shift_no]
      );

      const dropRes = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN tl.status = 'ACTIVE' AND t.status = 'COMPLETED' THEN tl.amount ELSE 0 END), 0) AS ok_drops,
           COALESCE(SUM(CASE WHEN tl.status = 'CANCELLED' OR t.status = 'CANCELLED' THEN tl.amount ELSE 0 END), 0) AS cancelled_drops
         FROM transaction_lines tl
         JOIN transactions t ON t.id = tl.transaction_id
         WHERE t.store_id = $1 AND t.business_date = $2 AND t.shift_no = $3
           AND t.tx_type = 'CASH_DROP' AND tl.line_type = 'CASH_DROP'`,
        [storeId, businessDate, sh.shift_no]
      );

      const openingFloat = d(sh.opening_float);
      const netCashTaken = d(cashTenderRes.rows[0]?.net_cash);
      const okDrops = d(dropRes.rows[0]?.ok_drops);
      const cancelledDrops = d(dropRes.rows[0]?.cancelled_drops);
      const expectedCash = openingFloat.plus(netCashTaken).minus(okDrops);
      const countedCash = d(sh.counted_cash);
      const variance = countedCash.minus(expectedCash); // negative = drawer short, positive = over

      let status = 'MATCHED';
      let explanation = null;
      if (!variance.isZero()) {
        status = 'MISMATCH';
        explanation =
          variance.isNegative()
            ? `Drawer short by $${fmt(variance.abs())} (Counted $${fmt(countedCash)} vs Expected $${fmt(expectedCash)}).`
            : `Drawer over by $${fmt(variance)} (Counted $${fmt(countedCash)} vs Expected $${fmt(expectedCash)}).`;
        if (!cancelledDrops.isZero() && variance.abs().equals(cancelledDrops.abs())) {
          explanation += ` Matches cancelled cash drop amount ($${fmt(cancelledDrops)}).`;
        }
      } else if (hasMissingOrFlagged) {
        status = 'REVIEW_REQUIRED';
        explanation = 'Cash matches, but day has flagged or quarantined records.';
      }

      shiftCashChecks.push({
        shiftNo: sh.shift_no,
        openingFloat: fmt(openingFloat),
        netCashTaken: fmt(netCashTaken),
        completedCashDrops: fmt(okDrops),
        cancelledCashDrops: fmt(cancelledDrops),
        expectedCash: fmt(expectedCash),
        countedCash: fmt(countedCash),
        variance: fmt(variance),
        status,
        explanation,
      });
    }

    return {
      storeId,
      businessDate,
      eodPresent: Boolean(eod),
      computedTxCount,
      reportedTxCount: eod ? eod.reported_tx_count : null,
      flaggedTxCount,
      quarantinedFiles: quarRes.rows,
      headlineChecks,
      departmentChecks,
      tenderChecks,
      internalConsistency,
      shiftCashChecks,
    };
  } finally {
    client.release();
  }
}