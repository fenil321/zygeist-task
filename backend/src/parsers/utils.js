import Decimal from "decimal.js";

// Configure half-up rounding to match retail tax & line rounding rules
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export function toMoney(val) {
  if (val === null || val === undefined || val === "") return "0.00";
  return new Decimal(val).toFixed(2);
}

export function minorToMoney(minorVal) {
  if (minorVal === null || minorVal === undefined) return "0.00";
  return new Decimal(minorVal).div(100).toFixed(2);
}

export function normalizeDept(dept) {
  if (dept === null || dept === undefined || dept === "") return null;
  const trimmed = String(dept).trim().replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

export function ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}
