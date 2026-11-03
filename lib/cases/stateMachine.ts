// Dunning case state machine. Pure: no I/O, no clock. Illegal transitions throw.
// Partial payments are ledger entries, never states. Waiting-day guards live in the rules engine
// (earliestStageDate); this module only decides which state changes are legal.

export const ACTIVE_STATES = ["open", "overdue", "reminded", "mahnung1", "mahnung2", "handover_ready"] as const;
export type ActiveState = (typeof ACTIVE_STATES)[number];

export const CASE_STATES = [
  ...ACTIVE_STATES,
  "paused_dispute",
  "closed_paid",
  "closed_refunded",
  "closed_cancelled",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

/** States from which nothing can follow. closed_paid is not terminal: a refund or a reopen may follow. */
export const TERMINAL_STATES: readonly CaseState[] = ["closed_refunded", "closed_cancelled"];

export interface CaseSnapshot {
  state: CaseState;
  /** Active state to return to: after a dispute pause, or on reopen after closed_paid. */
  resumeState: ActiveState | null;
  /** Set exactly when state is paused_dispute, e.g. "dispute:PP-D-123". */
  pausedReason: string | null;
}

export type CaseEvent =
  | { type: "became_overdue" }
  | { type: "reminder_sent"; approvedStepId: string }
  | { type: "mahnung1_sent"; approvedStepId: string }
  | { type: "mahnung2_sent"; approvedStepId: string }
  | { type: "handover_prepared"; approvedStepId: string }
  | { type: "dispute_opened"; reason: string }
  | { type: "dispute_resolved"; reason: string }
  | { type: "paid_in_full" }
  | { type: "refunded_in_full" }
  | { type: "cancelled" }
  | { type: "reopened" };

export type CaseEventType = CaseEvent["type"];

export class IllegalTransitionError extends Error {
  readonly from: CaseState;
  readonly event: CaseEventType;
  constructor(from: CaseState, event: CaseEventType, why?: string) {
    super(`Illegal transition: ${event} from ${from}${why ? ` (${why})` : ""}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.event = event;
  }
}

export function isActive(s: CaseState): s is ActiveState {
  return (ACTIVE_STATES as readonly string[]).includes(s);
}

export function isClosed(s: CaseState): boolean {
  return s === "closed_paid" || s === "closed_refunded" || s === "closed_cancelled";
}

export function isCaseState(s: string): s is CaseState {
  return (CASE_STATES as readonly string[]).includes(s);
}

/** Linear dunning ladder: event -> required from-state -> to-state. */
const LADDER: Partial<Record<CaseEventType, { from: ActiveState; to: ActiveState }>> = {
  became_overdue: { from: "open", to: "overdue" },
  reminder_sent: { from: "overdue", to: "reminded" },
  mahnung1_sent: { from: "reminded", to: "mahnung1" },
  mahnung2_sent: { from: "mahnung1", to: "mahnung2" },
  handover_prepared: { from: "mahnung2", to: "handover_ready" },
};

/** Events that represent an outbound or handover step: each needs a human-approved step id. */
const NEEDS_APPROVAL: ReadonlySet<CaseEventType> = new Set(["reminder_sent", "mahnung1_sent", "mahnung2_sent", "handover_prepared"]);

function requireApproval(cur: CaseSnapshot, event: CaseEvent): void {
  if (!NEEDS_APPROVAL.has(event.type)) return;
  const id = (event as { approvedStepId?: unknown }).approvedStepId;
  if (typeof id !== "string" || id.trim() === "") {
    throw new IllegalTransitionError(cur.state, event.type, "requires an approved step");
  }
}

function assertSnapshot(s: CaseSnapshot): void {
  if (!isCaseState(s.state)) throw new RangeError(`Unknown case state ${String(s.state)}`);
  if ((s.state === "paused_dispute") !== (s.pausedReason !== null)) {
    throw new RangeError("pausedReason must be set exactly when the state is paused_dispute");
  }
  if (s.resumeState !== null && !isActive(s.resumeState)) throw new RangeError(`Invalid resumeState ${String(s.resumeState)}`);
  if (s.state === "paused_dispute" && s.resumeState === null) throw new RangeError("paused_dispute needs a resumeState");
}

/** Returns the next snapshot. Never mutates the input. Throws IllegalTransitionError. */
export function transition(cur: CaseSnapshot, event: CaseEvent): CaseSnapshot {
  assertSnapshot(cur);
  const s = cur.state;
  if (TERMINAL_STATES.includes(s)) throw new IllegalTransitionError(s, event.type, "case is closed");

  const step = LADDER[event.type];
  if (step) {
    if (s !== step.from) throw new IllegalTransitionError(s, event.type, `only from ${step.from}`);
    requireApproval(cur, event);
    return { state: step.to, resumeState: null, pausedReason: null };
  }

  switch (event.type) {
    case "dispute_opened": {
      if (!isActive(s)) throw new IllegalTransitionError(s, event.type, "only from an active state");
      if (!event.reason) throw new IllegalTransitionError(s, event.type, "reason required");
      return { state: "paused_dispute", resumeState: s, pausedReason: event.reason };
    }
    case "dispute_resolved": {
      if (s !== "paused_dispute") throw new IllegalTransitionError(s, event.type, "case is not paused");
      if (event.reason !== cur.pausedReason) throw new IllegalTransitionError(s, event.type, "paused for a different reason");
      return { state: cur.resumeState as ActiveState, resumeState: null, pausedReason: null };
    }
    case "paid_in_full": {
      if (isActive(s)) return { state: "closed_paid", resumeState: s, pausedReason: null };
      if (s === "paused_dispute") return { state: "closed_paid", resumeState: cur.resumeState, pausedReason: null };
      throw new IllegalTransitionError(s, event.type);
    }
    case "refunded_in_full": {
      if (isActive(s) || s === "paused_dispute" || s === "closed_paid") {
        return { state: "closed_refunded", resumeState: null, pausedReason: null };
      }
      throw new IllegalTransitionError(s, event.type);
    }
    case "cancelled": {
      if (isActive(s) || s === "paused_dispute") return { state: "closed_cancelled", resumeState: null, pausedReason: null };
      throw new IllegalTransitionError(s, event.type, "a paid case cannot be cancelled");
    }
    case "reopened": {
      if (s !== "closed_paid") throw new IllegalTransitionError(s, event.type, "only from closed_paid");
      if (cur.resumeState === null) throw new IllegalTransitionError(s, event.type, "no state to reopen to");
      return { state: cur.resumeState, resumeState: null, pausedReason: null };
    }
    default:
      throw new IllegalTransitionError(s, event.type, "unknown event");
  }
}

/** True when the event is legal from the snapshot (does not throw). */
export function canTransition(cur: CaseSnapshot, event: CaseEvent): boolean {
  try {
    transition(cur, event);
    return true;
  } catch (err) {
    if (err instanceof IllegalTransitionError) return false;
    throw err;
  }
}
