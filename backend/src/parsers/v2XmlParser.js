import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ensureArray, normalizeDept, toMoney } from "./utils.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  allowBooleanAttributes: true,
});

export function parseV2Xml(rawContent, filename) {
  if (!rawContent || !rawContent.trim().startsWith("<")) {
    throw new Error(`Malformed XML header in ${filename}`);
  }

  // Strict XML syntax validation so corrupted/truncated files are caught and quarantined
  const validation = XMLValidator.validate(rawContent);
  if (validation !== true) {
    const errMsg = validation?.err?.msg || "Invalid XML syntax";
    throw new Error(`XML validation failed in ${filename}: ${errMsg}`);
  }

  const parsed = xmlParser.parse(rawContent);

  if (parsed.TransactionLog) {
    return parseV2Tlog(parsed.TransactionLog, filename);
  }
  if (parsed.ShiftClose) {
    return parseV2Shift(parsed.ShiftClose, filename);
  }
  if (parsed.EndOfDay) {
    return parseV2Eod(parsed.EndOfDay, filename);
  }
  if (parsed.PriceList) {
    return parseV2PriceList(parsed.PriceList, filename);
  }
  if (parsed.ChangeAck) {
    return parseV2Ack(parsed.ChangeAck);
  }
  if (parsed.ChangeReject) {
    return parseV2Rej(parsed.ChangeReject);
  }

  throw new Error(`Unknown XML root element in ${filename}`);
}

function parseV2Tlog(root, filename) {
  if (!root.storeId || !root.businessDate) {
    throw new Error(`Missing storeId or businessDate in ${filename}`);
  }

  const rawTxs = ensureArray(root.Transaction);
  const transactions = rawTxs.map((tx) => {
    const txType = String(tx.type || "").toUpperCase();
    const status = String(tx.status || "").toUpperCase();
    const lines = [];

    for (const item of ensureArray(tx.ItemLine)) {
      lines.push({
        lineNo: Number(item.line || lines.length + 1),
        lineType: "ITEM",
        itemCode: item.itemCode ? String(item.itemCode) : null,
        variant: item.variant
          ? String(item.variant)
          : item.itemCode
            ? "000"
            : null,
        description: item.desc || item.description || null,
        deptCode: normalizeDept(item.dept),
        qty: item.qty !== undefined ? String(item.qty) : "1",
        unitPrice: toMoney(item.unitPrice),
        amount: toMoney(item.amount),
        taxGroup: item.taxGroup || null,
        status: String(item.status || "ACTIVE").toUpperCase(),
        cardLast4: null,
        envelopeNo: null,
      });
    }

    for (const gc of ensureArray(tx.GiftCardLine)) {
      lines.push({
        lineNo: Number(gc.line || lines.length + 1),
        lineType: "GIFT_CARD_LOAD",
        itemCode: null,
        variant: null,
        description: `Gift Card ${gc.action || "LOAD"}`,
        deptCode: null,
        qty: "1.000",
        unitPrice: toMoney(gc.amount),
        amount: toMoney(gc.amount),
        taxGroup: null,
        status: String(gc.status || "ACTIVE").toUpperCase(),
        cardLast4: gc.cardLast4 || null,
        envelopeNo: null,
      });
    }

    for (const drop of ensureArray(tx.CashDrop)) {
      lines.push({
        lineNo: lines.length + 1,
        lineType: "CASH_DROP",
        itemCode: null,
        variant: null,
        description: `Cash Drop Envelope ${drop.envelope || ""}`.trim(),
        deptCode: null,
        qty: "1.000",
        unitPrice: toMoney(drop.amount),
        amount: toMoney(drop.amount),
        taxGroup: null,
        status:
          String(drop.status || "OK").toUpperCase() === "CANCELLED"
            ? "CANCELLED"
            : "ACTIVE",
        cardLast4: null,
        envelopeNo: drop.envelope ? String(drop.envelope) : null,
      });
    }

    const taxes = ensureArray(tx.Tax).map((t) => ({
      taxGroup: t.group,
      taxableAmount: toMoney(t.taxable),
      taxAmount: toMoney(t.amount),
    }));

    const tenders = ensureArray(tx.Tender).map((p) => ({
      tenderType: String(p.type || "").toUpperCase(),
      amount: toMoney(p.amount),
      tendered: p.tendered !== undefined ? toMoney(p.tendered) : null,
      changeGiven: p.change !== undefined ? toMoney(p.change) : null,
      cardType: p.cardType || null,
      cardLast4: p.last4 || p.cardLast4 || null,
      authCode: p.auth || null,
      wallet: p.wallet || null,
      accountId: p.account || null,
    }));

    const tot = tx.Total || {};
    return {
      seq: Number(tx.seq),
      txType,
      status,
      deviceId: String(tx.device),
      staffId: String(tx.staff ?? "0"),
      shiftNo: Number(tx.shift || 1),
      startedAt: tx.start,
      endedAt: tx.end || null,
      originalSeq: tx.originalSeq ? Number(tx.originalSeq) : null,
      netAmount: toMoney(tot.net),
      taxAmount: toMoney(tot.tax),
      giftCardLoadAmount: toMoney(tot.giftCardLoads),
      grandTotal: toMoney(tot.total),
      lines,
      taxes,
      tenders,
    };
  });

  return {
    kind: "TLOG",
    format: "TLOG_V2",
    storeId: root.storeId,
    businessDate: root.businessDate,
    batchSeq: Number(root.batchSeq || 0),
    transactions,
  };
}

function parseV2Shift(root, filename) {
  if (!root.storeId || !root.businessDate) {
    throw new Error(`Invalid ShiftClose XML in ${filename}`);
  }

  const tenders = ensureArray(root.Tenders?.Tender).map((t) => ({
    method: String(t.type).toUpperCase(),
    count: Number(t.count || 0),
    amount: toMoney(t.amount),
  }));

  const payload = {
    payments: tenders,
    giftCards: {
      loads: Number(root.GiftCards?.loads || 0),
      loadAmount: toMoney(root.GiftCards?.loadAmount || root.GiftCards?.amount),
    },
    cashDrops: {
      count: Number(root.CashDrops?.count || 0),
      amount: toMoney(root.CashDrops?.amount),
      cancelled: Number(root.CashDrops?.cancelled || 0),
    },
    exceptions: {
      lineVoids: Number(root.Exceptions?.lineVoids || 0),
      lineVoidAmount: toMoney(root.Exceptions?.lineVoidAmount),
      cancelledTransactions: Number(
        root.Exceptions?.cancelledTransactions || 0,
      ),
      cancelledAmount: toMoney(root.Exceptions?.cancelledAmount),
      refunds: Number(root.Exceptions?.refunds || 0),
      refundAmount: toMoney(root.Exceptions?.refundAmount),
      noSales: Number(root.Exceptions?.noSales || 0),
    },
    accountCharges: ensureArray(root.AccountCharges?.Charge).map((c) => ({
      accountId: c.account || c.accountId,
      seq: Number(c.seq),
      amount: toMoney(c.amount),
    })),
  };

  return {
    kind: "SHIFT",
    format: "SHIFT_V2",
    storeId: root.storeId,
    businessDate: root.businessDate,
    shiftNo: Number(root.shift || root.shiftNo || 1),
    openingFloat: toMoney(root.Cash?.openingFloat),
    countedCash: toMoney(root.Cash?.countedCash),
    payload,
  };
}

function parseV2Eod(root, filename) {
  if (!root.storeId || !root.businessDate) {
    throw new Error(`Invalid EndOfDay XML in ${filename}`);
  }

  const payload = {
    departments: ensureArray(root.Departments?.Department).map((d) => ({
      deptCode: normalizeDept(d.code || d.dept),
      name: d.name || "",
      quantity: String(d.quantity || d.qty || "0"),
      amount: toMoney(d.amount),
    })),
    taxes: ensureArray(root.Taxes?.Tax).map((t) => ({
      taxGroup: t.group || t.code,
      taxableAmount: toMoney(t.taxable),
      taxAmount: toMoney(t.amount),
    })),
    payments: ensureArray(root.Tenders?.Tender).map((t) => ({
      method: String(t.type).toUpperCase(),
      count: Number(t.count || 0),
      amount: toMoney(t.amount),
    })),
    giftCards: {
      loads: Number(root.GiftCards?.loads || 0),
      loadAmount: toMoney(root.GiftCards?.loadAmount || root.GiftCards?.amount),
    },
    cashDrops: {
      count: Number(root.CashDrops?.count || 0),
      amount: toMoney(root.CashDrops?.amount),
      cancelled: Number(root.CashDrops?.cancelled || 0),
    },
    exceptions: {
      lineVoids: Number(root.Exceptions?.lineVoids || 0),
      lineVoidAmount: toMoney(root.Exceptions?.lineVoidAmount),
      cancelledTransactions: Number(
        root.Exceptions?.cancelledTransactions || 0,
      ),
      cancelledAmount: toMoney(root.Exceptions?.cancelledAmount),
      refunds: Number(root.Exceptions?.refunds || 0),
      refundAmount: toMoney(root.Exceptions?.refundAmount),
      noSales: Number(root.Exceptions?.noSales || 0),
    },
    accountCharges: ensureArray(root.AccountCharges?.Charge).map((c) => ({
      accountId: c.account || c.accountId,
      seq: Number(c.seq),
      amount: toMoney(c.amount),
    })),
  };

  const tot = root.Totals || {};
  return {
    kind: "EOD",
    format: "EOD_V2",
    storeId: root.storeId,
    businessDate: root.businessDate,
    reportedTxCount: Number(tot.transactions || 0),
    reportedNetSales: toMoney(tot.netSales),
    reportedTax: toMoney(tot.tax),
    reportedGcLoads: toMoney(tot.giftCardLoads),
    reportedGrandTotal: toMoney(tot.grandTotal),
    payload,
  };
}

function parseV2PriceList(root, filename) {
  const storeId = root.storeId || filename.split("_")[1]?.replace(".xml", "");
  const departments = ensureArray(root.Departments?.Department).map((d) => ({
    deptCode: normalizeDept(d.code || d.id),
    name: d.name || `Dept ${d.code || d.id}`,
  }));

  const items = ensureArray(root.Items?.Item).map((i) => ({
    itemCode: String(i.code || i.itemCode),
    variant: String(i.variant || "000"),
    description: i.description || i.desc || "",
    deptCode: normalizeDept(i.dept),
    price: toMoney(i.price),
    taxGroup: i.taxGroup || "T0",
    minAge: Number(i.minAge || 0),
    unit: i.unit || "EA",
    containers: Number(i.containers || 0),
  }));

  return {
    kind: "PRICELIST",
    format: "PRICELIST_XML",
    storeId,
    departments,
    items,
  };
}

function parseV2Ack(root) {
  return {
    kind: "ACK",
    format: "ACK_XML",
    storeId: root.storeId,
    changeId: root.changeId,
    processedAt: root.processed,
    result: root.result,
    items: ensureArray(root.ItemResult).map((r) => ({
      itemCode: String(r.code),
      variant: String(r.variant || "000"),
      action: r.action,
      result: r.result,
      errorCode: r.errorCode || null,
      message: r.message || null,
    })),
  };
}

function parseV2Rej(root) {
  return {
    kind: "REJ",
    format: "REJ_XML",
    storeId: root.storeId,
    changeId: root.changeId,
    processedAt: root.processed,
    errorCode: root.errorCode,
    message: root.message,
  };
}
