# In-Store Hub File Exchange Specification

Document revision 2.1-r7 (excerpt prepared for integration partners). Some sections are summarized. Where this document and the files the hub actually writes disagree, the files are correct.

## 1. Folders

| Folder | Written by | Read by |
| --- | --- | --- |
| `outbox/` | The hub | Any integrated software |
| `inbox/` | Integrated software | The hub |

- The hub never deletes files from `outbox/`. Several programs may read the same folder, so **integrated software must not delete, move, rename or lock files in `outbox/`**. Keep track of what you have read on your side.
- The hub polls `inbox/` every 30 seconds. It ignores files whose names end in `.tmp`. Write your file as `<name>.tmp` and rename it when it is complete; the hub may pick up a half-written file otherwise.
- After processing a change file, the hub moves it to `inbox/processed/` and writes the result to `outbox/`.

## 2. Files the hub writes

| Pattern | Contents | When |
| --- | --- | --- |
| `TLOG_<store>_<batchSeq>.xml` / `.json` | A batch of transactions | Roughly every 2 hours while open, and at closing |
| `SHIFT_<store>_<yyyymmdd>_<shiftNo>.xml` / `.json` | Shift summary | At each shift change (14:00) and at closing |
| `EOD_<store>_<yyyymmdd>.xml` / `.json` | End-of-day summary | Shortly after closing (21:00) |
| `PRICELIST_<store>.xml` | Full price list export | On request |
| `ACK_<store>_<changeId>.xml` | Result of a change file | After processing a change file |
| `REJ_<store>_<changeId>.xml` | Change file rejected as a whole | After processing a change file |

- `batchSeq` increases by one for every batch file the hub writes. It is not the same as the transaction sequence number.
- A batch is normally written within a few minutes of the period it covers. After a network or power problem, the hub writes delayed batches when it recovers; it may also write the same batch more than once.
- `yyyymmdd` in summary file names is the business date.
- The **business date** of a transaction is the `businessDate` of the batch it arrived in. Do not derive it from the file name or the file time.
- Transaction sequence numbers (`seq`) are unique within a store and increase over time. Every event (sale, refund, no-sale, cash drop) uses one.

## 3. Transaction log, format v2 (XML)

```xml
<TransactionLog formatVersion="2.1" storeId="BL01" businessDate="2026-10-01" batchSeq="1"
                created="2026-10-01 09:00:13" recordCount="40">
  <Transaction seq="100002" type="SALE" status="COMPLETED" device="R2" staff="202" shift="1"
               start="2026-10-01 07:05:17" end="2026-10-01 07:06:02">
    <ItemLine line="1" itemCode="200000003012" variant="000" desc="Turkey Club Sandwich" dept="13"
              qty="1" unitPrice="8.95" amount="8.95" taxGroup="T2"/>
    <ItemLine line="2" ... status="VOID"/>
    <GiftCardLine line="3" action="LOAD" cardLast4="4821" amount="25.00"/>
    <Tax group="T2" taxable="8.95" amount="0.85"/>
    <Tender type="CASH" amount="34.80" tendered="40.00" change="5.20"/>
    <Total net="8.95" tax="0.85" giftCardLoads="25.00" total="34.80"/>
  </Transaction>
</TransactionLog>
```

### 3.1 Transaction attributes

| Attribute | Meaning |
| --- | --- |
| `seq` | Sequence number, unique per store |
| `type` | `SALE`, `REFUND`, `NO_SALE`, `CASH_DROP` |
| `status` | `COMPLETED` or `CANCELLED`. A cancelled transaction was abandoned before payment; it has lines but no tenders. |
| `device` | Register or kiosk id (see `master/devices.csv`) |
| `staff` | Staff id; `0` for unattended self-checkout |
| `shift` | 1 (opening to 14:00) or 2 (14:00 to close) |
| `originalSeq` | On refunds: the sale being refunded |

### 3.2 Lines

- `ItemLine`: `itemCode` and `variant` are omitted for keyed open-department sales. `qty` may be a decimal for items sold by weight (pounds, up to 3 decimal places). `amount` = `qty` x `unitPrice`, rounded half up to the cent. A line with `status="VOID"` was removed by the cashier before payment and is not part of the sale.
- On refunds, `qty` and `amount` are negative.
- `GiftCardLine`: a gift card load (money placed on a gift card). It is not a sale and is not taxed.
- `Tax`: tax per tax group for this transaction, calculated on the total taxable amount of the group and rounded half up.

### 3.3 Tenders

| `type` | Extra attributes |
| --- | --- |
| `CASH` | `tendered`, `change` |
| `CARD` | `cardType`, `last4`, `auth` |
| `MOBILE` | `wallet` |
| `GIFT` | `cardLast4` (gift card used as payment) |
| `ACCOUNT` | `account` (business account charge) |

`amount` is always the amount applied to the transaction. On refunds it is negative. A transaction can have more than one tender.

### 3.4 Other transaction types

- `NO_SALE`: the cash drawer was opened without a sale. No child elements.
- `CASH_DROP`: `<CashDrop envelope="3" amount="150.00" status="OK"/>`. Cash removed from the drawer to the safe. A drop that was started and cancelled is written with `status="CANCELLED"`.

## 4. Summaries, format v2

`ShiftClose` and `EndOfDay` contain `Tenders`, `GiftCards`, `CashDrops` and `Exceptions`. `EndOfDay` also contains `Departments`, `Taxes`, `AccountCharges` and `Totals`. `ShiftClose` also contains `Cash` (`openingFloat`, `countedCash`), the cash counted in the drawers at the end of the shift.

`Totals` attributes: `transactions` (completed sales and refunds), `netSales`, `tax`, `giftCardLoads`, `grandTotal`.

## 5. Format v3 (JSON)

Hub software 3.x writes transaction logs and summaries as JSON. The structure follows v2 with these main changes:

- Money is an integer number of cents in fields ending in `Minor` (for example `amountMinor: 465` = 4.65).
- Timestamps are ISO 8601 with a UTC offset.
- Department codes are 3-character strings.
- Field names are different; see the sample files for the full set.

Hubs are upgraded one store at a time, so both formats can be present for the same store and even the same day.

## 6. Price list export

`PRICELIST_<store>.xml` lists tax groups, departments and items. An item is identified by **item code + variant**. Variant `000` is the base item; other variants are sizes or pack options of the same item code with their own price. `containers` is the number of deposit containers in one unit (0 if none).

## 7. Change files (`inbox/`)

Change files always use the v2 XML layout. Hubs on software 3.x still accept them.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ChangeFile changeId="CHG-20261020-0001" storeId="BL01" created="2026-10-20 06:15:00">
  <Items>
    <Item action="update" code="200000001025" variant="000" price="4.45"/>
    <Item action="add" code="085612000778" variant="000" description="Ginger Beer 12oz"
          dept="11" price="2.29" taxGroup="T1" minAge="0" unit="EA" containers="1"/>
    <Item action="deactivate" code="200000002084" variant="000"/>
  </Items>
</ChangeFile>
```

### 7.1 Rules

| Rule | Error |
| --- | --- |
| `changeId` must be unique. A file whose `changeId` was already applied is not applied again; the hub writes an ACK with `result="ALREADY_APPLIED"`. | - |
| `storeId` must match the hub. | E301 (whole file) |
| The file must be well-formed XML with the elements above. | E302 (whole file) |
| `variant` is required on every item. Send `000` for the base item. | E312 |
| `description` at most 24 characters. | E315 |
| `price` greater than 0.00 and at most 999.99, exactly 2 decimal places. | E318 |
| `dept` must exist on the hub. | E320 |
| `taxGroup` must exist on the hub. | E321 |
| `update` and `deactivate` need an existing item; `add` needs a new one. | E330 / E331 |
| Account, staff, device and department maintenance is not accepted through files. Business accounts are created and edited at the hub terminal only. | E410 (whole file) |

Item-level errors do not stop the rest of the file: the ACK lists a result per item (`APPLIED` or `REJECTED` with `errorCode` and `message`), and the file `result` is `APPLIED`, `PARTIAL` or `REJECTED`. Whole-file errors produce a `REJ_` file and nothing is applied.

See `outbox/ACK_*` and `outbox/REJ_*` for examples.
