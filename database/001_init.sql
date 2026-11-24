-- 001_init.sql
BEGIN;

-- 1. Master Data
CREATE TABLE stores (
    store_id VARCHAR(10) PRIMARY KEY, -- 'BL01', 'BL02'
    name VARCHAR(100) NOT NULL,
    open_hour TIME DEFAULT '07:00:00',
    close_hour TIME DEFAULT '21:00:00'
);

CREATE TABLE devices (
    store_id VARCHAR(10) NOT NULL REFERENCES stores(store_id),
    device_id VARCHAR(10) NOT NULL, -- 'R1', 'R2' (counter), 'K1' (kiosk)
    device_type VARCHAR(20) NOT NULL, -- 'COUNTER' or 'SELF_CHECKOUT'
    name VARCHAR(100),
    PRIMARY KEY (store_id, device_id)
);

CREATE TABLE staff (
    staff_id VARCHAR(20) PRIMARY KEY, -- '0' for unattended kiosk
    store_id VARCHAR(10),
    name VARCHAR(100) NOT NULL,
    role VARCHAR(50)
);

CREATE TABLE departments (
    dept_code VARCHAR(10) PRIMARY KEY, -- Normalized code (e.g., '13', '50', '51')
    name VARCHAR(100) NOT NULL
);

CREATE TABLE items (
    store_id VARCHAR(10) NOT NULL REFERENCES stores(store_id),
    item_code VARCHAR(32) NOT NULL,
    variant VARCHAR(10) NOT NULL DEFAULT '000',
    description VARCHAR(100) NOT NULL,
    dept_code VARCHAR(10),
    price NUMERIC(12, 2) NOT NULL,
    tax_group VARCHAR(5) NOT NULL, -- 'T0', 'T1', 'T2'
    min_age INT NOT NULL DEFAULT 0,
    unit VARCHAR(10) NOT NULL DEFAULT 'EA',
    containers INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (store_id, item_code, variant)
);

-- 2. Transactions & Lines (Idempotent on store_id + seq)
CREATE TABLE transactions (
    id BIGSERIAL PRIMARY KEY,
    store_id VARCHAR(10) NOT NULL REFERENCES stores(store_id),
    seq BIGINT NOT NULL, -- Unique per store
    business_date DATE NOT NULL, -- Derived strictly from batch header
    batch_seq INT NOT NULL,
    source_file VARCHAR(255) NOT NULL,
    tx_type VARCHAR(20) NOT NULL, -- 'SALE', 'REFUND', 'NO_SALE', 'CASH_DROP'
    status VARCHAR(20) NOT NULL, -- 'COMPLETED', 'CANCELLED'
    device_id VARCHAR(10) NOT NULL,
    staff_id VARCHAR(20) NOT NULL,
    shift_no INT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    original_seq BIGINT, -- Populated on REFUND
    net_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    gift_card_load_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    needs_review BOOLEAN NOT NULL DEFAULT FALSE,
    review_reasons TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id, seq)
);

CREATE INDEX idx_transactions_store_date ON transactions(store_id, business_date);

CREATE TABLE transaction_lines (
    id BIGSERIAL PRIMARY KEY,
    transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    line_no INT NOT NULL,
    line_type VARCHAR(20) NOT NULL, -- 'ITEM', 'GIFT_CARD_LOAD', 'CASH_DROP'
    item_code VARCHAR(32), -- NULL for keyed open-department sales
    variant VARCHAR(10),
    description VARCHAR(100),
    dept_code VARCHAR(10),
    qty NUMERIC(12, 3), -- Up to 3 decimal places for weighted items
    unit_price NUMERIC(12, 2),
    amount NUMERIC(12, 2) NOT NULL,
    tax_group VARCHAR(5),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE' or 'VOID'
    card_last4 VARCHAR(4),
    envelope_no VARCHAR(20),
    needs_review BOOLEAN NOT NULL DEFAULT FALSE,
    review_reason TEXT
);

CREATE TABLE transaction_taxes (
    id BIGSERIAL PRIMARY KEY,
    transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tax_group VARCHAR(5) NOT NULL,
    taxable_amount NUMERIC(12, 2) NOT NULL,
    tax_amount NUMERIC(12, 2) NOT NULL
);

CREATE TABLE transaction_tenders (
    id BIGSERIAL PRIMARY KEY,
    transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tender_type VARCHAR(20) NOT NULL, -- 'CASH', 'CARD', 'MOBILE', 'GIFT', 'ACCOUNT'
    amount NUMERIC(12, 2) NOT NULL, -- Applied amount (negative on refunds)
    tendered NUMERIC(12, 2),
    change_given NUMERIC(12, 2),
    card_type VARCHAR(20),
    card_last4 VARCHAR(4),
    auth_code VARCHAR(30),
    wallet VARCHAR(30),
    account_id VARCHAR(30)
);

-- 3. Hub Summaries (ShiftClose & EndOfDay)
CREATE TABLE shift_summaries (
    id BIGSERIAL PRIMARY KEY,
    store_id VARCHAR(10) NOT NULL REFERENCES stores(store_id),
    business_date DATE NOT NULL,
    shift_no INT NOT NULL,
    source_file VARCHAR(255) NOT NULL,
    opening_float NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    counted_cash NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    raw_payload JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id, business_date, shift_no)
);

CREATE TABLE eod_summaries (
    id BIGSERIAL PRIMARY KEY,
    store_id VARCHAR(10) NOT NULL REFERENCES stores(store_id),
    business_date DATE NOT NULL,
    source_file VARCHAR(255) NOT NULL,
    reported_tx_count INT NOT NULL DEFAULT 0,
    reported_net_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reported_tax NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reported_gc_loads NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reported_grand_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    raw_payload JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id, business_date)
);

-- 4. Business Accounts (Read-Only from hub CSV + ACCOUNT tenders)
CREATE TABLE business_accounts (
    account_id VARCHAR(30) PRIMARY KEY,
    company_name VARCHAR(150) NOT NULL,
    contact_email VARCHAR(150),
    credit_limit NUMERIC(12, 2),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- 5. Price List Sync (Module 4)
CREATE TABLE price_change_batches (
    change_id VARCHAR(50) PRIMARY KEY, -- e.g., 'CHG-20261020-0001'
    store_id VARCHAR(10) NOT NULL REFERENCES stores(store_id),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPLIED', 'PARTIAL', 'REJECTED', 'ALREADY_APPLIED'
    reject_reason TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acked_at TIMESTAMPTZ
);

CREATE TABLE price_change_items (
    id BIGSERIAL PRIMARY KEY,
    change_id VARCHAR(50) NOT NULL REFERENCES price_change_batches(change_id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL, -- 'update', 'add', 'deactivate'
    item_code VARCHAR(32) NOT NULL,
    variant VARCHAR(10) NOT NULL DEFAULT '000',
    description VARCHAR(100),
    dept_code VARCHAR(10),
    old_price NUMERIC(12, 2),
    new_price NUMERIC(12, 2),
    tax_group VARCHAR(5),
    min_age INT DEFAULT 0,
    unit VARCHAR(10) DEFAULT 'EA',
    containers INT DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPLIED', 'REJECTED'
    error_code VARCHAR(10),
    error_message TEXT
);

-- 6. Import Audit & Quarantine (Module 1)
CREATE TABLE import_history (
    id BIGSERIAL PRIMARY KEY,
    store_id VARCHAR(10),
    filename VARCHAR(255) NOT NULL,
    file_sha256 VARCHAR(64) NOT NULL,
    file_format VARCHAR(30) NOT NULL,
    records_accepted INT NOT NULL DEFAULT 0,
    duplicates_skipped INT NOT NULL DEFAULT 0,
    rows_flagged INT NOT NULL DEFAULT 0,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (filename, file_sha256)
);

CREATE TABLE quarantined_files (
    id BIGSERIAL PRIMARY KEY,
    store_id VARCHAR(10),
    filename VARCHAR(255) NOT NULL,
    file_sha256 VARCHAR(64) NOT NULL,
    error_reason TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (filename, file_sha256)
);

-- 7. Supplier Invoices (Module 5A)
CREATE TABLE supplier_invoices (
    id BIGSERIAL PRIMARY KEY,
    supplier_name VARCHAR(150) NOT NULL,
    invoice_number VARCHAR(100) NOT NULL,
    invoice_date DATE,
    source_filename VARCHAR(255) NOT NULL,
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    fees NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    discounts NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    reported_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    computed_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', -- 'DRAFT', 'SAVED'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_invoice_lines (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    extracted_code VARCHAR(50),
    extracted_desc TEXT NOT NULL,
    case_qty NUMERIC(12, 3) NOT NULL DEFAULT 1,
    units_per_case NUMERIC(12, 3) NOT NULL DEFAULT 1,
    case_cost NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    unit_cost NUMERIC(12, 4) NOT NULL DEFAULT 0.0000,
    line_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    matched_item_code VARCHAR(32),
    matched_variant VARCHAR(10),
    match_confidence NUMERIC(5, 4),
    is_new_item BOOLEAN NOT NULL DEFAULT FALSE
);

COMMIT;