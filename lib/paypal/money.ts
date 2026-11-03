// Exact conversion between PayPal money strings ("123.45") and integer cents. No floats involved.

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

const VALUE_RE = /^(\d{1,13})(?:\.(\d+))?$/;

/**
 * Parses a PayPal money object into integer cents. Throws on a currency mismatch, a negative or
 * malformed value, or more than two significant decimals (no silent rounding of money).
 */
export function moneyToCents(money: PayPalMoney, expectedCurrency: string): number {
  if (money.currency_code !== expectedCurrency) {
    throw new RangeError(`Currency mismatch: expected ${expectedCurrency}, got ${money.currency_code}`);
  }
  const m = VALUE_RE.exec(money.value);
  if (!m) throw new RangeError(`Malformed money value: ${JSON.stringify(money.value)}`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 2) throw new RangeError(`Money value has more than 2 decimals: ${money.value}`);
  const cents = Number(m[1]) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Money value out of range: ${money.value}`);
  return cents;
}

export function centsToMoney(cents: number, currency: string): PayPalMoney {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`cents must be a non-negative safe integer, got ${cents}`);
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return { currency_code: currency, value: `${whole}.${frac}` };
}
