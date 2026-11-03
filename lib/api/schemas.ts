// Request body schemas for the service routes (strict: unknown keys are rejected).

import { z } from "zod";

const Nonce = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "nonce must be 8 to 64 characters [A-Za-z0-9_-]");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const Cents = z.number().int().positive().max(5_000_000);

export const CreateWorkspaceBody = z.strictObject({ name: z.string().trim().min(1).max(80).optional() });

export const AdvanceClockBody = z.strictObject({ days: z.number().int().min(1).max(60) });

export const CreateInvoiceBody = z.strictObject({
  debtorId: z.uuid(),
  amountCents: Cents,
  dueDate: IsoDate,
  fixedCalendarDue: z.boolean().optional(),
  defaultWarningPrinted: z.boolean().optional(),
  description: z.string().trim().max(200).optional(),
  nonce: Nonce,
});

export const EmptyBody = z.strictObject({});

/** Approve body: the fingerprint of the wording the person saw (see draftFingerprint). Optional for API callers. */
export const ApproveBody = z.strictObject({ draftFingerprint: z.string().trim().max(64).optional() });

export const RejectStepBody = z.strictObject({ note: z.string().trim().max(500).optional() });

export const SimulateBody = z.strictObject({
  nonce: Nonce,
  action: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("pay_full") }),
    z.strictObject({ type: z.literal("pay_partial"), amountCents: Cents }),
    z.strictObject({ type: z.literal("refund"), amountCents: Cents.optional() }),
    z.strictObject({ type: z.literal("dispute_open") }),
    z.strictObject({ type: z.literal("dispute_resolve") }),
  ]),
});
