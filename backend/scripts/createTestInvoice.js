import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { pool } from '../src/db.js';

dotenv.config();

function buildPdfBuffer(lines) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let y = 745;
  const ops = ['BT', '/F1 9.5 Tf'];
  for (const line of lines) {
    ops.push(`1 0 0 1 42 ${y} Tm (${esc(line)}) Tj`);
    y -= 15;
  }
  ops.push('ET');
  const stream = ops.join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }

  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

async function main() {
  const { rows } = await pool.query(
    `SELECT item_code, description, price
     FROM items
     WHERE store_id = 'BL01' AND is_active = TRUE
     ORDER BY item_code
     LIMIT 3`
  );

  const lineItems = rows.map((item, idx) => {
    const qty = (idx + 2) * 3; // 6, 9, 12
    const unitCost = Math.max(1.25, Number((Number(item.price) * 0.62).toFixed(2)));
    const total = Number((qty * unitCost).toFixed(2));
    return {
      no: idx + 1,
      sku: item.item_code,
      desc: item.description.slice(0, 26),
      qty,
      uom: 'EA',
      unitCost,
      total,
    };
  });

  // Add 2 brand-new items (Line 5 includes an intentional +$5.00 math overcharge)
  lineItems.push({
    no: 4,
    sku: '8841209',
    desc: 'Organic Honeycrisp Cider',
    qty: 8,
    uom: 'EA',
    unitCost: 4.50,
    total: 36.00,
  });
  lineItems.push({
    no: 5,
    sku: '8841215',
    desc: 'Artisan Rosemary Focaccia',
    qty: 10,
    uom: 'EA',
    unitCost: 3.10,
    total: 36.00, // Intentional error: 10 x $3.10 = $31.00, printed as $36.00
  });

  const subtotal = Number(lineItems.reduce((s, l) => s + l.total, 0).toFixed(2));
  const tax = 0.00;
  const deliveryFee = 7.50;
  const grandTotal = Number((subtotal + tax + deliveryFee).toFixed(2));

  const pad = (v, len, right = false) =>
    right ? String(v).padStart(len, ' ') : String(v).padEnd(len, ' ');

  const docLines = [
    'ORCHARD VALLEY ORGANICS WHOLESALE',
    '418 Harvest Way, Portland, OR 97209 | AP Billing: ap@orchardvalley.example',
    '--------------------------------------------------------------------------',
    'INVOICE #: OVO-99412                      INVOICE DATE: 2026-10-12',
    'BILL TO:   Brightleaf Market - Store BL01 DUE DATE:     2026-11-11',
    '--------------------------------------------------------------------------',
    `${pad('LN', 3)} ${pad('SKU', 15)} ${pad('DESCRIPTION', 27)} ${pad('QTY', 5, true)} ${pad('COST', 8, true)} ${pad('TOTAL', 9, true)}`,
    '--------------------------------------------------------------------------',
    ...lineItems.map(
      (l) =>
        `${pad(l.no, 3)} ${pad(l.sku, 15)} ${pad(l.desc, 27)} ${pad(l.qty, 5, true)} ${pad('$' + l.unitCost.toFixed(2), 8, true)} ${pad('$' + l.total.toFixed(2), 9, true)}`
    ),
    '--------------------------------------------------------------------------',
    `${pad('SUBTOTAL:', 61, true)} ${pad('$' + subtotal.toFixed(2), 10, true)}`,
    `${pad('TAX:', 61, true)} ${pad('$' + tax.toFixed(2), 10, true)}`,
    `${pad('COLD-CHAIN DELIVERY FEE:', 61, true)} ${pad('$' + deliveryFee.toFixed(2), 10, true)}`,
    `${pad('TOTAL DUE (USD):', 61, true)} ${pad('$' + grandTotal.toFixed(2), 10, true)}`,
    '--------------------------------------------------------------------------',
    'RECEIVING NOTE: 1 outer carton crushed in transit; $4.50 credit pending.',
  ];

  const outFile = path.resolve('../data_package/invoices/OrchardValley_OVO-99412.pdf');
  await fs.writeFile(outFile, buildPdfBuffer(docLines));
  console.log('Created test invoice:', outFile);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
