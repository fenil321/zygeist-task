import pg from "pg";
import dotenv from "dotenv";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected error on idle PostgreSQL client:", err);
});

pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error(
      "[DB] Active PostgreSQL client connection error:",
      err.message,
    );
  });
});

export async function query(text, params) {
  return pool.query(text, params);
}
