# Mahnwerk status

Entry for the PayPal AI Hackathon. Live demo: https://mahnwerk.vercel.app. Sandbox only.

## What it is
Dunning and receivables engine for German freelancers and small firms on PayPal Invoicing. A rules engine in plain code decides default, interest and flat fee (BGB 286, 288, 367). Claude drafts letter wording, classifies debtor replies and explains steps. A human approves every outbound step.

## Legal and rate facts used
- Basiszinssatz 1.52 percent from 2026-07-01 (Deutsche Bundesbank).
- Default interest: base rate plus 9 points (no consumer) or plus 5 points (consumer), BGB 288(1), (2). Interest runs on the open principal only.
- 40 EUR flat fee only when the debtor is not a consumer, BGB 288(5).
- BGB 286(3): default at the latest 30 days after due date and receipt. The period ends with day 30 (BGB 187, 188), so default starts on day 31. A consumer only if the invoice warned about it.
- Payments are allocated to fee, then interest, then principal (BGB 367). Refunds reduce the claim and never reopen it.

## PayPal sandbox facts
- Invoice emails never reach real inboxes.
- At most 2 invoice reminders per day per API caller, shared by all visitors. Beyond that the app sends an in-app letter and says so.
- Sent invoices cannot be deleted. Webhook simulator events fail signature verification.

## Operations
- Supabase project mahnwerk (eu-central-1), Vercel project mahnwerk, auto-deploy on push to main.
- Demo workspaces expire after 48 hours and are purged 7 days later (pg_cron).
- AI budget: 40 calls per demo workspace, 150 per day for the shared example workspace, 500 per day for everything.
- Migrations 0001 to 0007 are applied in order. The example workspace is seeded by scripts/seed-golden-sql.ts.

## Checks
npm test, npm run typecheck, npm run lint, npm run build. All tests run offline with fakes.
