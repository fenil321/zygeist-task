import Decimal from 'decimal.js';
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../db.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Compute new prices for bulk rules (e.g., +5% rounded to end in .x9) without mutating DB.
 */
export async function previewBulkPriceRule({
  storeId,
  deptCode,
  percentChange,
  fixedDelta,
  roundEndingDigit, // e.g., 9 -> rounds cents so last digit ends in 9 (.09, .19, ..., .99)
}) {
  const conditions = ['store_id = $1', 'is_active = TRUE'];
  const params = [storeId];

  if (deptCode) {
    params.push(deptCode);
    conditions.push(`dept_code = $${params.length}`);
  }

  const res = await pool.query(
    `SELECT item_code, variant, description, dept_code, price, tax_group
     FROM items
     WHERE ${conditions.join(' AND ')}
     ORDER BY dept_code, description`,
    params
  );

  return res.rows.map((row) => {
    let price = new Decimal(row.price);

    if (percentChange !== undefined && percentChange !== null && percentChange !== '') {
      const multiplier = new Decimal(1).plus(new Decimal(percentChange).div(100));
      price = price.mul(multiplier).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    if (fixedDelta !== undefined && fixedDelta !== null && fixedDelta !== '') {
      price = price.plus(new Decimal(fixedDelta)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    if (roundEndingDigit !== undefined && roundEndingDigit !== null && roundEndingDigit !== '') {
      const targetDigit = Number(roundEndingDigit);
      if (targetDigit >= 0 && targetDigit <= 9) {
        const cents = price.mul(100).round().toNumber();
        const currentLast = cents % 10;
        let adjustedCents = cents + (targetDigit - currentLast);
        if (adjustedCents <= 0) adjustedCents += 10;
        price = new Decimal(adjustedCents).div(100);
      }
    }

    return {
      itemCode: row.item_code,
      variant: row.variant,
      description: row.description,
      deptCode: row.dept_code,
      taxGroup: row.tax_group,
      oldPrice: new Decimal(row.price).toFixed(2),
      newPrice: price.toFixed(2),
    };
  });
}

/**
 * Persist a price change batch in Postgres and write atomic .tmp -> .xml file to inbox/.
 * Idempotent on changeId so restarts never apply or send the same change twice.
 */
export async function sendPriceChangeBatch({ storeId, changeId, items, inboxDir }) {
  const finalChangeId =
    changeId || `CHG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Prevent duplicate sending of an already recorded changeId
    const existing = await client.query(
      'SELECT change_id, status FROM price_change_batches WHERE change_id = $1',
      [finalChangeId]
    );
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return { changeId: finalChangeId, status: existing.rows[0].status, alreadyExisted: true };
    }

    await client.query(
      `INSERT INTO price_change_batches (change_id, store_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [finalChangeId, storeId]
    );

    const xmlLines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<ChangeFile changeId="${escapeXml(finalChangeId)}" storeId="${escapeXml(storeId)}" created="${new Date().toISOString().replace('T', ' ').slice(0, 19)}">`,
      '  <Items>',
    ];

    for (const item of items) {
      const action = item.action || 'update';
      const variant = item.variant ?? '000';
      const newPrice =
        item.newPrice !== undefined && item.newPrice !== null && item.newPrice !== ''
          ? new Decimal(item.newPrice).toFixed(2)
          : null;

      await client.query(
        `INSERT INTO price_change_items
           (change_id, action, item_code, variant, description, dept_code, old_price, new_price, tax_group, min_age, unit, containers, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING')`,
        [
          finalChangeId,
          action,
          item.itemCode,
          variant,
          item.description || null,
          item.deptCode || null,
          item.oldPrice || null,
          newPrice,
          item.taxGroup || null,
          item.minAge ?? 0,
          item.unit || 'EA',
          item.containers ?? 0,
        ]
      );

      const attrs = [`action="${escapeXml(action)}"`, `code="${escapeXml(item.itemCode)}"`, `variant="${escapeXml(variant)}"`];
      if (item.description !== undefined && item.description !== null) {
        attrs.push(`description="${escapeXml(item.description)}"`);
      }
      if (item.deptCode) attrs.push(`dept="${escapeXml(item.deptCode)}"`);
      if (newPrice !== null) attrs.push(`price="${escapeXml(newPrice)}"`);
      if (item.taxGroup) attrs.push(`taxGroup="${escapeXml(item.taxGroup)}"`);
      if (action === 'add') {
        attrs.push(`minAge="${item.minAge ?? 0}"`);
        attrs.push(`unit="${escapeXml(item.unit || 'EA')}"`);
        attrs.push(`containers="${item.containers ?? 0}"`);
      }

      xmlLines.push(`    <Item ${attrs.join(' ')}/>`);
    }

    xmlLines.push('  </Items>', '</ChangeFile>', '');
    const xmlContent = xmlLines.join('\n');

    await fs.mkdir(inboxDir, { recursive: true });
    const tmpFile = path.join(inboxDir, `${finalChangeId}.xml.tmp`);
    const finalFile = path.join(inboxDir, `${finalChangeId}.xml`);
    await fs.writeFile(tmpFile, xmlContent, 'utf8');
    await fs.rename(tmpFile, finalFile);

    await client.query('COMMIT');
    return { changeId: finalChangeId, status: 'PENDING', itemCount: items.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Generate monthly statement for a business account (read-only hub account + ACCOUNT tenders).
 */
export async function getBusinessAccountStatements(monthPrefix) {
  // Ensure any accountId seen in tenders exists in business_accounts
  await pool.query(`
    INSERT INTO business_accounts (account_id, company_name)
    SELECT DISTINCT account_id, 'Account ' || account_id
    FROM transaction_tenders
    WHERE account_id IS NOT NULL
    ON CONFLICT (account_id) DO NOTHING
  `);

  const accountsRes = await pool.query('SELECT * FROM business_accounts ORDER BY account_id');
  const statements = [];

  for (const acc of accountsRes.rows) {
    const params = [acc.account_id];
    let dateFilter = '';
    if (monthPrefix) {
      params.push(`${monthPrefix}%`);
      dateFilter = `AND TO_CHAR(t.business_date, 'YYYY-MM') LIKE $2`;
    }

    const txRes = await pool.query(
      `SELECT t.store_id, t.seq, t.business_date, t.tx_type, tp.amount
       FROM transaction_tenders tp
       JOIN transactions t ON t.id = tp.transaction_id
       WHERE tp.tender_type = 'ACCOUNT'
         AND tp.account_id = $1
         AND t.status = 'COMPLETED'
         ${dateFilter}
       ORDER BY t.business_date, t.seq`,
      params
    );

    let totalCharges = new Decimal(0);
    let totalCredits = new Decimal(0);
    for (const row of txRes.rows) {
      const amt = new Decimal(row.amount);
      if (amt.isNegative()) totalCredits = totalCredits.plus(amt.abs());
      else totalCharges = totalCharges.plus(amt);
    }

    statements.push({
      accountId: acc.account_id,
      companyName: acc.company_name,
      contactEmail: acc.contact_email,
      creditLimit: acc.credit_limit,
      month: monthPrefix || 'ALL',
      totalCharges: totalCharges.toFixed(2),
      totalCredits: totalCredits.toFixed(2),
      netBalanceDue: totalCharges.minus(totalCredits).toFixed(2),
      entries: txRes.rows,
    });
  }

  return statements;
}