// Tiny UTC calendar-day helpers. A date is an ISO string YYYY-MM-DD.
// Internally we map each date to an integer day number (days since 1970-01-01 UTC),
// so there is no timezone or DST drift.

import type { ISODate } from "./types";

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toDayNumber(iso: ISODate): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new RangeError(`Invalid ISO date: ${iso}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const day = ms / MS_PER_DAY;
  if (fromDayNumber(day) !== iso) throw new RangeError(`Invalid calendar date: ${iso}`);
  return day;
}

export function fromDayNumber(day: number): ISODate {
  if (!Number.isInteger(day)) throw new RangeError(`Day number must be an integer: ${day}`);
  const dt = new Date(day * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, "0");
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

export function addDays(iso: ISODate, n: number): ISODate {
  return fromDayNumber(toDayNumber(iso) + n);
}

/** b minus a, in days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(b) - toDayNumber(a);
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return toDayNumber(a) >= toDayNumber(b) ? a : b;
}

export function isValidIsoDate(iso: string): boolean {
  try {
    toDayNumber(iso);
    return true;
  } catch {
    return false;
  }
}
