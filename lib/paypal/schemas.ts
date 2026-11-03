// Zod schemas for the PayPal responses Mahnwerk relies on. Only fields we use are required;
// unknown fields are kept (looseObject) so callers can still inspect them.

import { z } from "zod";

export const MoneySchema = z.object({
  currency_code: z.string().length(3),
  value: z.string(),
});

export const LinkSchema = z.looseObject({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

export const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
});

export const PaymentDetailSchema = z.looseObject({
  type: z.string().optional(),
  payment_id: z.string().optional(),
  transaction_id: z.string().optional(),
  payment_date: z.string().optional(),
  method: z.string().optional(),
  note: z.string().optional(),
  amount: MoneySchema,
});

export const RefundDetailSchema = z.looseObject({
  type: z.string().optional(),
  refund_id: z.string().optional(),
  transaction_id: z.string().optional(),
  refund_date: z.string().optional(),
  method: z.string().optional(),
  amount: MoneySchema,
});

export const InvoiceSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  detail: z
    .looseObject({
      invoice_number: z.string().optional(),
      invoice_date: z.string().optional(),
      currency_code: z.string().optional(),
      payment_term: z.looseObject({ due_date: z.string().optional() }).optional(),
    })
    .optional(),
  amount: z.looseObject({ currency_code: z.string().length(3), value: z.string() }).optional(),
  due_amount: MoneySchema.optional(),
  payments: z
    .looseObject({
      paid_amount: MoneySchema.optional(),
      transactions: z.array(PaymentDetailSchema).optional(),
    })
    .optional(),
  refunds: z
    .looseObject({
      refund_amount: MoneySchema.optional(),
      transactions: z.array(RefundDetailSchema).optional(),
    })
    .optional(),
  links: z.array(LinkSchema).optional(),
});
export type PayPalInvoice = z.infer<typeof InvoiceSchema>;

export const InvoiceNumberSchema = z.looseObject({ invoice_number: z.string().min(1) });

export const SearchInvoicesSchema = z.looseObject({
  total_items: z.number().int().optional(),
  total_pages: z.number().int().optional(),
  items: z.array(InvoiceSchema).default([]),
});

export const RecordPaymentResponseSchema = z.looseObject({ payment_id: z.string().min(1) });
export const RecordRefundResponseSchema = z.looseObject({ refund_id: z.string().min(1) });

/** Response of send: either a link description, or an empty body (202). */
export const SendInvoiceResponseSchema = z.looseObject({}).or(z.null());

export const DisputedTransactionSchema = z.looseObject({
  seller_transaction_id: z.string().optional(),
  buyer_transaction_id: z.string().optional(),
  invoice_number: z.string().optional(),
});

export const DisputeSchema = z.looseObject({
  dispute_id: z.string().min(1),
  status: z.string(),
  reason: z.string().optional(),
  dispute_state: z.string().optional(),
  dispute_outcome: z.looseObject({ outcome_code: z.string().optional() }).optional(),
  dispute_amount: MoneySchema.optional(),
  disputed_transactions: z.array(DisputedTransactionSchema).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});
export type PayPalDispute = z.infer<typeof DisputeSchema>;

export const DisputeListSchema = z.looseObject({
  items: z.array(z.looseObject({ dispute_id: z.string(), status: z.string().optional() })).default([]),
  links: z.array(LinkSchema).optional(),
});

export const CaptureRefundSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  amount: MoneySchema.optional(),
  invoice_id: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type PayPalCaptureRefund = z.infer<typeof CaptureRefundSchema>;

export const VerifySignatureResponseSchema = z.looseObject({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});

export const WebhookEventSchema = z.looseObject({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource_type: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
  create_time: z.string().optional(),
});
export type PayPalWebhookEvent = z.infer<typeof WebhookEventSchema>;
