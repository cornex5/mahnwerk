import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATES,
  CASE_STATES,
  IllegalTransitionError,
  TERMINAL_STATES,
  canTransition,
  isActive,
  transition,
  type ActiveState,
  type CaseEvent,
  type CaseSnapshot,
  type CaseState,
} from "./stateMachine";

const snap = (state: CaseState, resumeState: ActiveState | null = null, pausedReason: string | null = null): CaseSnapshot => ({
  state,
  resumeState,
  pausedReason,
});
const at = (s: CaseState) => (s === "paused_dispute" ? snap(s, "reminded", "dispute:D1") : s === "closed_paid" ? snap(s, "mahnung1") : snap(s));

describe("happy path ladder", () => {
  it("walks open to handover_ready, every outbound step needs an approved step", () => {
    let s = snap("open");
    s = transition(s, { type: "became_overdue" });
    expect(s.state).toBe("overdue");
    s = transition(s, { type: "reminder_sent", approvedStepId: "st1" });
    expect(s.state).toBe("reminded");
    s = transition(s, { type: "mahnung1_sent", approvedStepId: "st2" });
    s = transition(s, { type: "mahnung2_sent", approvedStepId: "st3" });
    s = transition(s, { type: "handover_prepared", approvedStepId: "st4" });
    expect(s).toEqual(snap("handover_ready"));
  });

  it("refuses outbound steps without approval", () => {
    expect(() => transition(snap("overdue"), { type: "reminder_sent", approvedStepId: "" })).toThrow(/approved step/);
    expect(() => transition(snap("reminded"), { type: "mahnung1_sent", approvedStepId: "  " })).toThrow(IllegalTransitionError);
    expect(() => transition(snap("mahnung1"), { type: "mahnung2_sent" } as unknown as CaseEvent)).toThrow(IllegalTransitionError);
  });

  it("refuses skipping stages", () => {
    expect(() => transition(snap("open"), { type: "reminder_sent", approvedStepId: "x" })).toThrow(/only from overdue/);
    expect(() => transition(snap("overdue"), { type: "mahnung1_sent", approvedStepId: "x" })).toThrow(IllegalTransitionError);
    expect(() => transition(snap("reminded"), { type: "mahnung2_sent", approvedStepId: "x" })).toThrow(IllegalTransitionError);
    expect(() => transition(snap("overdue"), { type: "became_overdue" })).toThrow(IllegalTransitionError);
  });
});

describe("disputes", () => {
  it("pauses from any active state and resumes to the same state", () => {
    for (const a of ACTIVE_STATES) {
      const p = transition(snap(a), { type: "dispute_opened", reason: "dispute:D1" });
      expect(p).toEqual(snap("paused_dispute", a, "dispute:D1"));
      expect(transition(p, { type: "dispute_resolved", reason: "dispute:D1" })).toEqual(snap(a));
    }
  });
  it("does not resume on another dispute's resolution", () => {
    const p = transition(snap("mahnung1"), { type: "dispute_opened", reason: "dispute:D1" });
    expect(() => transition(p, { type: "dispute_resolved", reason: "dispute:D2" })).toThrow(/different reason/);
  });
  it("cannot pause twice, or pause a closed case", () => {
    expect(() => transition(at("paused_dispute"), { type: "dispute_opened", reason: "dispute:D2" })).toThrow();
    expect(() => transition(at("closed_paid"), { type: "dispute_opened", reason: "dispute:D2" })).toThrow();
  });
  it("blocks dunning steps while paused", () => {
    expect(() => transition(snap("paused_dispute", "reminded", "dispute:D1"), { type: "mahnung1_sent", approvedStepId: "x" })).toThrow();
  });
});

describe("closing", () => {
  it("paid from active or paused keeps the active state for a reopen", () => {
    expect(transition(snap("mahnung2"), { type: "paid_in_full" })).toEqual(snap("closed_paid", "mahnung2"));
    expect(transition(snap("paused_dispute", "reminded", "dispute:D1"), { type: "paid_in_full" })).toEqual(snap("closed_paid", "reminded"));
    expect(transition(snap("closed_paid", "mahnung2"), { type: "reopened" })).toEqual(snap("mahnung2"));
  });
  it("refund closes from closed_paid, active and paused", () => {
    expect(transition(snap("closed_paid", "open"), { type: "refunded_in_full" }).state).toBe("closed_refunded");
    expect(transition(snap("overdue"), { type: "refunded_in_full" }).state).toBe("closed_refunded");
  });
  it("a paid case cannot be cancelled; refunded and cancelled are terminal", () => {
    expect(() => transition(snap("closed_paid", "open"), { type: "cancelled" })).toThrow(/paid case/);
    for (const t of TERMINAL_STATES) {
      expect(() => transition(snap(t), { type: "paid_in_full" })).toThrow(/closed/);
      expect(() => transition(snap(t), { type: "reopened" })).toThrow(/closed/);
    }
    expect(() => transition(snap("closed_paid", "open"), { type: "paid_in_full" })).toThrow();
    expect(() => transition(snap("overdue"), { type: "reopened" })).toThrow();
  });
});

describe("snapshot validation", () => {
  it("rejects inconsistent snapshots", () => {
    expect(() => transition(snap("paused_dispute"), { type: "paid_in_full" })).toThrow(RangeError);
    expect(() => transition(snap("open", null, "x"), { type: "became_overdue" })).toThrow(RangeError);
    expect(() => transition({ state: "nope" as CaseState, resumeState: null, pausedReason: null }, { type: "became_overdue" })).toThrow(RangeError);
  });
});

// ---- property tests (seeded PRNG, no extra dependency) ----

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvent(r: () => number): CaseEvent {
  const reasons = ["dispute:D1", "dispute:D2"];
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const approved = r() < 0.85 ? `step-${Math.floor(r() * 100)}` : "";
  const all: CaseEvent[] = [
    { type: "became_overdue" },
    { type: "reminder_sent", approvedStepId: approved },
    { type: "mahnung1_sent", approvedStepId: approved },
    { type: "mahnung2_sent", approvedStepId: approved },
    { type: "handover_prepared", approvedStepId: approved },
    { type: "dispute_opened", reason: pick(reasons) },
    { type: "dispute_resolved", reason: pick(reasons) },
    { type: "paid_in_full" },
    { type: "refunded_in_full" },
    { type: "cancelled" },
    { type: "reopened" },
  ];
  // Ladder events are weighted up so long runs reach the late stages.
  return r() < 0.5 ? pick(all.slice(0, 5)) : pick(all);
}

const ORDER: Record<ActiveState, number> = { open: 0, overdue: 1, reminded: 2, mahnung1: 3, mahnung2: 4, handover_ready: 5 };

describe("properties over random event sequences", () => {
  it("holds invariants for 2000 random runs", () => {
    const visited = new Set<CaseState>(["open"]);
    for (let seed = 1; seed <= 2000; seed++) {
      const r = prng(seed);
      let s = snap("open");
      let maxStage = 0;
      for (let i = 0; i < 40; i++) {
        const ev = randomEvent(r);
        const before = JSON.stringify(s);
        let next: CaseSnapshot;
        try {
          next = transition(s, ev);
        } catch (err) {
          expect(err).toBeInstanceOf(IllegalTransitionError);
          expect(JSON.stringify(s)).toBe(before); // purity: input untouched
          expect(canTransition(s, ev)).toBe(false);
          continue;
        }
        expect(canTransition(s, ev)).toBe(true);
        expect(JSON.stringify(s)).toBe(before);
        // state is always valid and consistent
        expect(CASE_STATES).toContain(next.state);
        expect(next.state === "paused_dispute").toBe(next.pausedReason !== null);
        if (next.state === "paused_dispute") expect(isActive(next.resumeState as CaseState)).toBe(true);
        // outbound steps only ever happen with an approval id
        if ("approvedStepId" in ev) expect(ev.approvedStepId.trim()).not.toBe("");
        // terminal states are absorbing
        expect(TERMINAL_STATES.includes(s.state)).toBe(false);
        // the dunning stage never goes backwards (resume and reopen return to the stage left)
        if (isActive(next.state)) {
          expect(ORDER[next.state]).toBeGreaterThanOrEqual(maxStage);
          maxStage = ORDER[next.state];
        }
        visited.add(next.state);
        s = next;
      }
    }
    expect([...visited].sort()).toEqual([...CASE_STATES].sort());
  });

  it("every (state, event) pair is either legal or throws IllegalTransitionError, never anything else", () => {
    const events: CaseEvent[] = [
      { type: "became_overdue" },
      { type: "reminder_sent", approvedStepId: "a" },
      { type: "mahnung1_sent", approvedStepId: "a" },
      { type: "mahnung2_sent", approvedStepId: "a" },
      { type: "handover_prepared", approvedStepId: "a" },
      { type: "dispute_opened", reason: "dispute:D1" },
      { type: "dispute_resolved", reason: "dispute:D1" },
      { type: "paid_in_full" },
      { type: "refunded_in_full" },
      { type: "cancelled" },
      { type: "reopened" },
    ];
    let legal = 0;
    for (const st of CASE_STATES) {
      for (const ev of events) {
        if (canTransition(at(st), ev)) legal++;
      }
    }
    // 5 ladder + 6 pause + 1 resume + 7 paid + 8 refunded + 7 cancelled + 1 reopen
    expect(legal).toBe(35);
  });
});
