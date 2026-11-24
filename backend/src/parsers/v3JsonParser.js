import { minorToMoney, normalizeDept } from "./utils.js";

export function parseV3Json(rawContent, filename) {
  const data = JSON.parse(rawContent);
  const schema = data.schema || "";

  if (schema.startsWith("tlog/")) {
    return parseV3Tlog(data, filename);
  }
  if (schema.startsWith("shift/")) {
    return parseV3Shift(data, filename);
  }
  if (schema.startsWith("endofday/")) {
    return parseV3Eod(data, filename);
  }

  throw new Error(`Unsupported v3 JSON schema '${schema}' in ${filename}`);
}

function parseV3Tlog(data, filename) {
  if (!data.store || !data.businessDay || !Array.isArray(data.transactions)) {
    throw new Error(`Missing required TLOG v3 root fields in ${filename}`);
  }

  const transactions = data.transactions.map((tx) => {
    const kind = String(tx.kind || "").toUpperCase();
    const state = String(tx.state || "").toUpperCase();
    const lines = [];

    if (kind === "CASH_DROP" && tx.drop) {
      lines.push({
        lineNo: 1,
        lineType: "CASH_DROP",
        itemCode: null,
        variant: null,
        description: `Cash Drop Envelope ${tx.drop.envelopeNo || ""}`.trim(),
        deptCode: null,
        qty: "1.000",
        unitPrice: minorToMoney(tx.drop.amountMinor),
        amount: minorToMoney(tx.drop.amountMinor),
        taxGroup: null,
        status: tx.drop.cancelled ? "CANCELLED" : "ACTIVE",
        cardLast4: null,
        envelopeNo: tx.drop.envelopeNo ? String(tx.drop.envelopeNo) : null,
      });
    } else {
      for (const l of tx.lines || []) {
        const lType = String(l.lineType || "item").toUpperCase();
        if (
          lType === "GIFTCARD" ||
          lType === "GIFT_CARD" ||
          lType === "GIFT_CARD_LOAD"
        ) {
          lines.push({
            lineNo: Number(l.lineNo || lines.length + 1),
            lineType: "GIFT_CARD_LOAD",
            itemCode: null,
            variant: null,
            description: l.text || "Gift Card Load",
            deptCode: null,
            qty: "1.000",
            unitPrice: minorToMoney(l.extendedMinor ?? l.amountMinor),
            amount: minorToMoney(l.extendedMinor ?? l.amountMinor),
            taxGroup: null,
            status: l.voided ? "VOID" : "ACTIVE",
            cardLast4: l.cardLast4 || l.panSuffix || null,
            envelopeNo: null,
          });
        } else {
          lines.push({
            lineNo: Number(l.lineNo || lines.length + 1),
            lineType: "ITEM",
            itemCode: l.sku ? String(l.sku) : null,
            variant: l.variant ? String(l.variant) : l.sku ? "000" : null,
            description: l.text || null,
            deptCode: normalizeDept(l.department),
            qty: l.quantity !== undefined ? String(l.quantity) : "1",
            unitPrice: minorToMoney(l.unitPriceMinor),
            amount: minorToMoney(l.extendedMinor),
            taxGroup: l.taxCode || null,
            status: l.voided ? "VOID" : "ACTIVE",
            cardLast4: null,
            envelopeNo: null,
          });
        }
      }
    }

    const taxes = (tx.taxes || []).map((t) => ({
      taxGroup: t.code,
      taxableAmount: minorToMoney(t.taxableMinor),
      taxAmount: minorToMoney(t.taxMinor),
    }));

    const tenders = (tx.payments || []).map((p) => ({
      tenderType: String(p.method || "").toUpperCase(),
      amount: minorToMoney(p.amountMinor),
      tendered:
        p.tenderedMinor !== undefined ? minorToMoney(p.tenderedMinor) : null,
      changeGiven:
        p.changeMinor !== undefined ? minorToMoney(p.changeMinor) : null,
      cardType: p.network || null,
      cardLast4: p.panSuffix || p.cardLast4 || null,
      authCode: p.approval || null,
      wallet: p.wallet || null,
      accountId: p.accountId || null,
    }));

    const totals = tx.totals || {};
    return {
      seq: Number(tx.sequenceNo),
      txType: kind,
      status: state,
      deviceId: String(tx.terminal),
      staffId: String(tx.operator ?? "0"),
      shiftNo: Number(tx.shiftNo || 1),
      startedAt: tx.startedAt,
      endedAt: tx.endedAt || null,
      originalSeq: tx.refundOf ? Number(tx.refundOf) : null,
      netAmount: minorToMoney(totals.netMinor),
      taxAmount: minorToMoney(totals.taxMinor),
      giftCardLoadAmount: minorToMoney(totals.giftCardLoadsMinor),
      grandTotal: minorToMoney(totals.grandMinor),
      lines,
      taxes,
      tenders,
    };
  });

  return {
    kind: "TLOG",
    format: "TLOG_V3",
    storeId: data.store,
    businessDate: data.businessDay,
    batchSeq: Number(data.batch?.seq || 0),
    transactions,
  };
}

function parseV3Shift(data, filename) {
  if (!data.store || !data.businessDay || data.shiftNo === undefined) {
    throw new Error(`Invalid SHIFT v3 file ${filename}`);
  }

  const normalizedPayload = {
    payments: (data.payments || []).map((p) => ({
      method: String(p.method).toUpperCase(),
      count: Number(p.count || 0),
      amount: minorToMoney(p.amountMinor),
    })),
    giftCards: {
      loads: Number(data.giftCards?.loads || 0),
      loadAmount: minorToMoney(data.giftCards?.loadAmountMinor),
    },
    cashDrops: {
      count: Number(data.cashDrops?.count || 0),
      amount: minorToMoney(data.cashDrops?.amountMinor),
      cancelled: Number(data.cashDrops?.cancelled || 0),
    },
    exceptions: {
      lineVoids: Number(data.exceptions?.lineVoids || 0),
      lineVoidAmount: minorToMoney(data.exceptions?.lineVoidAmountMinor),
      cancelledTransactions: Number(
        data.exceptions?.cancelledTransactions || 0,
      ),
      cancelledAmount: minorToMoney(data.exceptions?.cancelledAmountMinor),
      refunds: Number(data.exceptions?.refunds || 0),
      refundAmount: minorToMoney(data.exceptions?.refundAmountMinor),
      noSales: Number(data.exceptions?.noSales || 0),
    },
    accountCharges: (data.accountCharges || []).map((a) => ({
      accountId: a.accountId,
      seq: Number(a.sequenceNo),
      amount: minorToMoney(a.amountMinor),
    })),
  };

  return {
    kind: "SHIFT",
    format: "SHIFT_V3",
    storeId: data.store,
    businessDate: data.businessDay,
    shiftNo: Number(data.shiftNo),
    openingFloat: minorToMoney(data.cash?.openingFloatMinor),
    countedCash: minorToMoney(data.cash?.countedMinor),
    payload: normalizedPayload,
  };
}

function parseV3Eod(data, filename) {
  if (!data.store || !data.businessDay || !data.totals) {
    throw new Error(`Invalid EOD v3 file ${filename}`);
  }

  const normalizedPayload = {
    departments: (data.departments || []).map((d) => ({
      deptCode: normalizeDept(d.department),
      name: d.name || "",
      quantity: String(d.quantity || "0"),
      amount: minorToMoney(d.amountMinor),
    })),
    taxes: (data.taxes || []).map((t) => ({
      taxGroup: t.code,
      taxableAmount: minorToMoney(t.taxableMinor),
      taxAmount: minorToMoney(t.taxMinor),
    })),
    payments: (data.payments || []).map((p) => ({
      method: String(p.method).toUpperCase(),
      count: Number(p.count || 0),
      amount: minorToMoney(p.amountMinor),
    })),
    giftCards: {
      loads: Number(data.giftCards?.loads || 0),
      loadAmount: minorToMoney(data.giftCards?.loadAmountMinor),
    },
    cashDrops: {
      count: Number(data.cashDrops?.count || 0),
      amount: minorToMoney(data.cashDrops?.amountMinor),
      cancelled: Number(data.cashDrops?.cancelled || 0),
    },
    exceptions: {
      lineVoids: Number(data.exceptions?.lineVoids || 0),
      lineVoidAmount: minorToMoney(data.exceptions?.lineVoidAmountMinor),
      cancelledTransactions: Number(
        data.exceptions?.cancelledTransactions || 0,
      ),
      cancelledAmount: minorToMoney(data.exceptions?.cancelledAmountMinor),
      refunds: Number(data.exceptions?.refunds || 0),
      refundAmount: minorToMoney(data.exceptions?.refundAmountMinor),
      noSales: Number(data.exceptions?.noSales || 0),
    },
    accountCharges: (data.accountCharges || []).map((a) => ({
      accountId: a.accountId,
      seq: Number(a.sequenceNo),
      amount: minorToMoney(a.amountMinor),
    })),
  };

  return {
    kind: "EOD",
    format: "EOD_V3",
    storeId: data.store,
    businessDate: data.businessDay,
    reportedTxCount: Number(data.totals.transactions || 0),
    reportedNetSales: minorToMoney(data.totals.netMinor),
    reportedTax: minorToMoney(data.totals.taxMinor),
    reportedGcLoads: minorToMoney(data.totals.giftCardLoadsMinor),
    reportedGrandTotal: minorToMoney(data.totals.grandMinor),
    payload: normalizedPayload,
  };
}
