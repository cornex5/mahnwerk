-- Mahnwerk 0002: at most one fee_invoice step per dunning case.
-- The reconciler proposes a fee_invoice step (interest and flat fee still owed after PayPal marks
-- the invoice paid). Webhook replays and concurrent deliveries must never create a second one.
-- Any status counts: a rejected proposal is a human decision and is not proposed again.
-- NOT applied automatically. Apply after review.

begin;

create unique index steps_one_fee_invoice_per_case
  on public.steps (case_id)
  where kind = 'fee_invoice';

commit;
