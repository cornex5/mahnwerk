// Money helpers: integer cents for amounts, decimal.js for rate math.

import Decimal from "decimal.js";

/** Isolated Decimal constructor with enough precision for any realistic claim. */
export const Dec = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export type DecValue = InstanceType<typeof Dec>;

export function assertCents(value: number, name: string, opts: { allowZero?: boolean } = {}): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer in cents, got ${value}`);
  if (value < 0 || (value === 0 && !opts.allowZero)) {
    throw new RangeError(`${name} must be ${opts.allowZero ? ">= 0" : "> 0"}, got ${value}`);
  }
}

/**
 * Exact (unrounded) simple interest:
 * principal x (rateBp / 10000) x days / basis.
 */
export function interestExact(principalCents: number, rateBp: number, days: number, basis: number): DecValue {
  return new Dec(principalCents).mul(rateBp).mul(days).div(new Dec(10_000).mul(basis));
}

/** Round half up to whole cents (half away from zero for negatives, which never occur for interest here). */
export function roundHalfUpCents(value: DecValue): number {
  const n = value.toDecimalPlaces(0, Dec.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(n)) throw new RangeError(`Rounded amount is not a safe integer: ${value.toString()}`);
  return n;
}
