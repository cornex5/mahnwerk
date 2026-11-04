// Pure helpers shared by the step drafts and the example workspace seed (no I/O, no server-only imports).

import type { LetterFacts } from "../ai/letterFacts";
import type { DunningKind } from "./claims";

/** Payment deadline written into a letter: virtual date plus these days (same periods as the template letters). */
export const DEADLINE_DAYS: Record<DunningKind, number> = { reminder: 7, mahnung1: 7, mahnung2: 10, handover: 14 };

/** Amounts and date a stored AI draft was written for; compared again when the step is sent. */
export interface DraftBasis {
  virtual_date: string;
  principal_cents: number;
  interest_cents: number;
  fee_cents: number;
  total_cents: number;
}

export function draftBasisOf(f: LetterFacts, virtualDate: string): DraftBasis {
  return { virtual_date: virtualDate, principal_cents: f.principalCents, interest_cents: f.interestCents, fee_cents: f.feeCents, total_cents: f.totalCents };
}

/** True when the draft carries no basis (hand-written, older) or its basis equals the current one. */
export function draftBasisMatches(draft: Record<string, unknown> | null, current: DraftBasis): boolean {
  const b = draft?.generated_for as Partial<DraftBasis> | undefined;
  if (!b) return true;
  return (
    b.virtual_date === current.virtual_date &&
    b.principal_cents === current.principal_cents &&
    b.interest_cents === current.interest_cents &&
    b.fee_cents === current.fee_cents &&
    b.total_cents === current.total_cents
  );
}
