# Brightleaf Market — Data Package

Synthetic data for the Full Stack AI Engineer take-home. Everything here is fictional: the company, stores, people, suppliers, card numbers and accounts. Amounts are in US dollars.

**Period:** 2026-10-01 to 2026-10-14 (14 business days) · **Stores:** BL01 Riverside, BL02 Old Town · **Hours:** 07:00–21:00

## Contents

| Path | What it is |
| --- | --- |
| `outbox/` | Every file the two in-store hubs wrote during the period, with file modification times set to when each file was written. Replay these in time order to simulate a live hub. |
| `inbox/` | Empty. Your change files go here (in your simulator's live copy). |
| `spec/exchange-format.md` | The hub's file-exchange specification (partial). |
| `master/` | Stores, devices (registers and self-checkout kiosks) and staff. |
| `business_accounts.csv` | Businesses that buy on account. Maintained at the hub terminal only. |
| `invoices/` | Six supplier invoices: text PDFs, phone photos and a scanned PDF. |

## Business rules and definitions

- **Net sales** = the sum of item line amounts on completed sales and refunds, excluding voided lines, before tax. Refund lines are negative.
- **Cancelled transactions** and **voided lines** are not sales.
- **Gift card loads** are money received that the store owes back as future purchases. They are not sales and are not taxed. Paying with a gift card (`GIFT` tender) is a normal tender.
- **Grand total** = net sales + tax + gift card loads = total of all tenders.
- **Bottle deposits** (department 51) and **bag fees** (department 50) are charged to the customer and counted in net sales.
- **Tax** is calculated per transaction and per tax group, rounded half up to the cent. Tax groups: T0 exempt, T1 8.00%, T2 9.50%.
- **Expected cash** for a shift = opening float + cash tenders (net of change; refunds are negative) − completed cash drops. Compare it with `countedCash` in the shift summary.
- **Counter sales** come from registers (`R*`), **self-checkout sales** from kiosks (`K*`).
- Use exact decimal arithmetic for all money. Do not use floating point.

## Data quality

The files come from real-world-style systems and are not clean. Expect duplicates, late and damaged files, unknown references, and summaries that disagree with the transactions. Do not edit any file. Handle each case in your application and keep a record of what you rejected or flagged and why.
