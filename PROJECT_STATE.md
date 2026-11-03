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
- [x] Supabase schema applied (0001 init, 0002 one fee_invoice step per case)
- [x] PayPal REST client (lib/paypal), state machine and reconciler (lib/cases), webhook route (app/api/webhooks/paypal); 106 tests pass offline, typecheck, eslint and next build clean
- [x] Env vars and PayPal webhook set by Jonas
- [x] Migrations 0003, 0004 applied; golden workspace seeded (88409d86-81a3-439c-8f01-17ad6ff111c3)
- [x] Service layer, AI layer (draft, explain, copilot, classify), UI, deployed on Vercel (mahnwerk.vercel.app)
- [x] Live E2E on sandbox verified: demo workspace, invoice create/send, remind, partial and full payment, PAID webhooks, dispute pause/resume, injection-safe classify, copilot, partial and full refund (fixed id-less refund rows)
- [x] Live: golden read-only (clock, approve, copilot proposals disabled), full chain reminder, 1st and 2nd Mahnung, handover notice, fee invoice approve and execute; interest math checked by hand (43 days gives 12.39)
- [x] Fixed: approval bound to the shown wording (draftFingerprint, live-verified conflict message); literal backslash-n in AI closings; German templates with umlauts and dd.mm.yyyy; golden letters reseeded
- [x] Migration 0005: daily pg_cron job (03:17 UTC) purges demo workspaces 7 days after expiry; tested, golden untouched. One stray audit row (action 'test') remains, audit_log is append-only
- [x] AI-look audit 2026-11-03: plainer letters and prompt style rules, less repeated copy, README intro, restyle to dark green (direction C chosen by Jonas): Plex fonts, section-mark logo, no pill or card grid, sentence-case labels, one main dashboard figure. Live on Vercel (2581273). Not yet restyled by eye: case page, queue, new-invoice form (same tokens, checked by text only); Devpost text (v3) and video script (v2) reworded in the project docs; AI letter checked live after the new prompt rules (wir/Sie voice, no filler); golden letters are still template-only
- [ ] Still to test: reminder quota fallback (2 per day), AI budget exhausted, expired workspace, RSC prefetch 503 seen once, "Sending..." hang seen once on fee invoice approve (server finished fine, tab renderer froze)
- [ ] Known: Sonnet 5.5 rejects forced tool_choice (client sends auto plus instruction); golden workspace shares one 40-call AI budget; German template letters use ASCII transliteration
- [ ] Deployed skeleton, Devpost draft (by Nov 5)

## Open items
- Jonas: PayPal developer account, Business sandbox with Invoicing and Disputes enabled, REST app credentials, Devpost registration
- Jonas: Supabase project choice, keys into env himself
- Jonas: Vercel project linked to the repo
- Decided: direct REST via fetch (no SDK) for Invoicing v2, Disputes and webhook verification
- Decide: refund semantics. The rules engine treats a refund as a negative payment (reopens principal); PayPal treats a merchant refund as money returned, often a claim reduction. Reconciler only reopens a case when PayPal reports due_amount > 0 and flags partial refunds for review
- Verify in sandbox: payment_id in invoice payments equals the capture/transaction id used by disputes and PAYMENT.CAPTURE.REFUNDED (linking depends on it); exact INVOICING webhook resource shape (resource.id vs resource.invoice.id, both handled)

## Decisions 2026-11-03 (Jonas)
- Refund reduces the claim (credit note), never reopens principal or interest; partial refund after payment is flagged for review.
- Paid case with accrued interest or fee still owed closes as closed_paid and proposes a fee_invoice step in the approval queue (nothing sent automatically).
- Mahnwerk is public at mahnwerk.vercel.app (Vercel protection off, sandbox data only).

## Devpost rules read 2026-11-03 (Jonas pasted the full page)
- Eligibility: adults, individuals allowed, Germany not excluded. Eligibility is settled, no early submission needed (drafts can be saved on Devpost until the deadline).
- Required: text description, working demo (hosted URL or run instructions), public repo with detectable open source license in the About section (MIT detected), public YouTube video under 3 minutes with no third-party trademarks or copyrighted music, all in English.
- Testing: the project must stay available free of charge and without restriction until the judging period ends (Dec 15 2026; winners about Dec 21). Keep Supabase, Vercel and the Anthropic key alive until then. Do not delete the Supabase project before Dec 21.
- Judging: stage 1 pass/fail on fit (PayPal and AI used), stage 2 five equal criteria: Technological Implementation, Design, Potential Impact, Innovation, Presentation. Judges may use automated AI analysis, so README and text must stand alone.
- Prizes of interest: Best Use of PayPal + AI (5000 USD), grand prizes, and AG Grid sponsor prizes (a project can win one main prize plus one sponsor prize). Winners may need a W-8BEN and are responsible for their own taxes.
