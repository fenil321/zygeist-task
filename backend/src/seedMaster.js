import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import dotenv from "dotenv";
import { pool } from "./db.js";
import { normalizeDept } from "./parsers/utils.js";

dotenv.config();

async function readCsvIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function seedMasterData() {
  const baseDir = path.resolve(process.env.MASTER_DATA_DIR || "../data_source");
  const masterDir = path.join(baseDir, "master");

  const stores = await readCsvIfExists(path.join(masterDir, "stores.csv"));
  const devices = await readCsvIfExists(path.join(masterDir, "devices.csv"));
  const staff = await readCsvIfExists(path.join(masterDir, "staff.csv"));
  const depts = await readCsvIfExists(path.join(masterDir, "departments.csv"));
  const accounts = await readCsvIfExists(
    path.join(baseDir, "business_accounts.csv"),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const s of stores) {
      await client.query(
        `INSERT INTO stores (store_id, name)
         VALUES ($1, $2)
         ON CONFLICT (store_id) DO UPDATE SET name = EXCLUDED.name`,
        [s.store_id, s.store_name || s.name || s.store_id],
      );
    }

    for (const d of devices) {
      await client.query(
        `INSERT INTO devices (store_id, device_id, device_type, name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (store_id, device_id) DO UPDATE SET
           device_type = EXCLUDED.device_type,
           name = EXCLUDED.name`,
        [
          d.store_id,
          d.device_id,
          d.device_type,
          d.display_name || d.name || d.device_id,
        ],
      );
    }

    // Seed unattended self-checkout operator '0' plus staff.csv
    await client.query(
      `INSERT INTO staff (staff_id, store_id, name, role)
       VALUES ('0', NULL, 'Self-Checkout Kiosk', 'System')
       ON CONFLICT (staff_id) DO NOTHING`,
    );

    for (const st of staff) {
      await client.query(
        `INSERT INTO staff (staff_id, store_id, name, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (staff_id) DO UPDATE SET
           store_id = EXCLUDED.store_id,
           name = EXCLUDED.name,
           role = EXCLUDED.role`,
        [String(st.staff_id), st.store_id || null, st.name, st.role || "Staff"],
      );
    }

    for (const dp of depts) {
      const code = normalizeDept(
        dp.dept_code || dp.department || dp.code || dp.id,
      );
      if (code) {
        await client.query(
          `INSERT INTO departments (dept_code, name)
           VALUES ($1, $2)
           ON CONFLICT (dept_code) DO UPDATE SET name = EXCLUDED.name`,
          [code, dp.name || dp.dept_name || `Department ${code}`],
        );
      }
    }

    for (const acc of accounts) {
      const id = acc.account_id || acc.id;
      if (!id) continue;
      await client.query(
        `INSERT INTO business_accounts (account_id, company_name, contact_email, credit_limit, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (account_id) DO UPDATE SET
           company_name = EXCLUDED.company_name,
           contact_email = EXCLUDED.contact_email,
           credit_limit = EXCLUDED.credit_limit`,
        [
          id,
          acc.company_name || acc.business_name || acc.name || id,
          acc.contact_email || acc.email || null,
          acc.credit_limit ? acc.credit_limit : null,
        ],
      );
    }

    await client.query("COMMIT");
    console.log(
      `[SEED] Loaded ${stores.length} stores, ${devices.length} devices, ${staff.length} staff, ${accounts.length} business accounts.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Allow running directly via `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  seedMasterData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
