# Mahnwerk project state

Entry for the PayPal AI Hackathon (Devpost). Deadline: Nov 12 2026 12:00 PST (21:00 Berlin). Internal target: submit Nov 11 evening.

## What it is
Dunning and receivables engine for German freelancers and small firms on PayPal Invoicing (sandbox only). A rule engine in code decides default, interest and flat fee (BGB 286, 288). Claude only drafts letters and classifies replies. A human approves every outbound step.

## Decisions (Jonas, Nov 3)
- Idea: Mahnwerk (German-law dunning engine). Plan approved as written.
- Repo: github.com/cornex5/mahnwerk, public, MIT.
- Hosting: Vercel (Jonas's account). Extra spend cap 100 EUR, ask before spending.
- Fable approved for research phase only.
- Video: screen recording with Jonas's own voiceover, he uploads and submits.
- English everywhere in product and docs. No em dash anywhere.

## Verified facts
- Basiszinssatz 1.52 percent from 2026-07-01 (Bundesbank). Default interest: base + 9 points (no consumer), base + 5 points (consumer), BGB 288(1),(2).
- 40 EUR flat fee only when debtor is not a consumer, BGB 288(5).
- BGB 286(3): default at the latest 30 days after due date and invoice receipt; consumer only if the invoice warned about it.
- E-invoice: receiving mandatory since 2025; issuing mandatory 2027 (turnover over 800k) and 2028 (all domestic B2B).
- PayPal sandbox: invoice emails never reach real inboxes; max 2 invoice reminders per day per API caller; sent invoices cannot be deleted; webhook simulator events fail signature verification.
- AG Studio has no built-in Anthropic adapter (custom adapter needed). AG Grid is a stretch layer only.

## Schedule
- Nov 3-4: scaffold, schema, rules engine, PayPal client, webhooks
- Nov 5: deployed skeleton, Devpost draft submitted (early eligibility check)
- Nov 6-7: AI layer, approval queue, demo clock, unhappy paths, judge workspaces
- Nov 8: MVP, judge walkthrough, AG Grid go/no-go 20:00 Berlin
- Nov 10: feature freeze 18:00, README, recording
- Nov 11: edit video, submit evening. Nov 12 buffer only.

## Status
- [x] Phase 0 research, Phase 1 plan approved
- [x] Repo attached and cloned, Next.js scaffold
- [x] Rules engine and tests 1-9 (26 tests pass; test 4 = 854 cents)
- [x] Supabase project mahnwerk (eu-central-1, ref rhelfhiiohajafwnkxhs) and Vercel project mahnwerk created, non-secret env set
- [x] Supabase schema written (supabase/migrations/0001_init.sql), NOT yet applied
- [x] PayPal REST client (lib/paypal), state machine and reconciler (lib/cases), webhook route (app/api/webhooks/paypal); 106 tests pass offline, typecheck, eslint and next build clean
- [ ] Apply migration via Supabase connector, set SUPABASE_SERVICE_ROLE_KEY and PAYPAL_WEBHOOK_ID in Vercel, register the webhook URL in the PayPal app
- [ ] Deployed skeleton, Devpost draft (by Nov 5)

## Open items
- Jonas: PayPal developer account, Business sandbox with Invoicing and Disputes enabled, REST app credentials, Devpost registration
- Jonas: Supabase project choice, keys into env himself
- Jonas: Vercel project linked to the repo
- Decided: direct REST via fetch (no SDK) for Invoicing v2, Disputes and webhook verification
- Decide: refund semantics. The rules engine treats a refund as a negative payment (reopens principal); PayPal treats a merchant refund as money returned, often a claim reduction. Reconciler only reopens a case when PayPal reports due_amount > 0 and flags partial refunds for review
- Verify in sandbox: payment_id in invoice payments equals the capture/transaction id used by disputes and PAYMENT.CAPTURE.REFUNDED (linking depends on it); exact INVOICING webhook resource shape (resource.id vs resource.invoice.id, both handled)
