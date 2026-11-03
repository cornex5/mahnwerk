import { SiteHeader, GITHUB_URL } from "@/components/SiteChrome";
import { StartButtons } from "@/components/StartButtons";
import { DE_BASE_RATES, DE_RULESET } from "@/lib/rules/de";
import { calculateClaim } from "@/lib/rules/engine";

const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const eur = (c: number) => EUR.format(c / 100);

// A worked example computed by the same rules engine the app uses (no AI, no network).
const EXAMPLE = calculateClaim({
  invoice: { principalCents: 200_000, dueDate: "2026-09-30", fixedCalendarDue: true, defaultWarningPrinted: true, debtorType: "business" },
  ledger: [],
  calcDate: "2026-11-20",
  ruleSet: DE_RULESET,
  baseRates: DE_BASE_RATES,
});
const EXAMPLE_RATE_BP = EXAMPLE.segments[0]?.rateBp ?? 0;

const STEPS = [
  { title: "Code decides.", body: "Default, interest, the 40 EUR flat fee and the next step, in integer cents. Tested against BGB 286 and 288." },
  { title: "Claude writes.", body: "Code fills in every amount, date and citation, checks the draft, and swaps in a template if the check fails." },
  { title: "You approve.", body: "Each outbound step waits in a queue until you approve it." },
  { title: "PayPal sandbox sends.", body: "Invoices, reminders and simulated payments run through PayPal Invoicing. No real money moves." },
];

export default function Home() {
  return (
    <>
      <SiteHeader>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-muted hover:text-ink">
          GitHub
        </a>
      </SiteHeader>
      <main id="main" className="pb-0">
        <section className="mx-auto grid max-w-7xl gap-10 px-4 pb-12 pt-10 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14 lg:pt-16">
          <div>
            <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
              Chase overdue invoices without guessing the law.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
              Mahnwerk watches your PayPal invoices. Plain code works out when a debtor is in default, what interest and fees are owed, and which step is next (BGB 286, 288). Claude writes the letter. You read it and approve it before anything goes out.
            </p>
            <div className="mt-7">
              <StartButtons />
            </div>
            <div role="note" className="mt-7 max-w-xl rounded-xl border border-warn-line bg-warn-soft p-4 text-sm">
              <p className="font-semibold text-warn">Not legal advice. Sandbox only.</p>
              <p className="mt-1">
                This is a hackathon demo on the PayPal sandbox. No real money moves, no real email is sent, and every debtor and invoice is fictional. Do not rely on it for a real claim.
              </p>
            </div>
          </div>

          <div className="lg:pt-6">
            <div className="rounded-2xl border border-line-strong bg-surface p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-muted">Worked example</p>
                  <p className="mt-1 text-sm font-medium">Invoice due 30 Sep 2026, business debtor, on 20 Nov 2026</p>
                </div>
                <span className="text-sm font-medium text-danger">In default</span>
              </div>
              <dl className="mt-5 space-y-2 bg-surface/90 text-sm">
                <Row label="Principal" value={eur(200_000)} />
                <Row label="Default start" value={EXAMPLE.defaultStart ? new Date(EXAMPLE.defaultStart + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "none"} />
                <Row label={`Interest (${(EXAMPLE_RATE_BP / 100).toFixed(2)}% = base 1.52% + 9.00%)`} value={eur(EXAMPLE.interestAccruedCents)} />
                <Row label="Flat fee (BGB 288(5))" value={eur(EXAMPLE.flatFeeCents)} />
                <div className="flex items-baseline gap-2 border-t-2 border-ink pt-2 text-base font-semibold">
                  <dt>Total owed</dt>
                  <span className="leader" aria-hidden="true" />
                  <dd className="num font-mono">{eur(EXAMPLE.totalDueCents)}</dd>
                </div>
              </dl>
              <p className="mt-4 text-xs text-muted">Computed live by the rules engine. Basiszinssatz {(DE_BASE_RATES[0].rateBp / 100).toFixed(2)}% from 1 Jul 2026 (Bundesbank).</p>
            </div>
          </div>
        </section>

        <section aria-label="How it works" className="border-t border-line">
          <ol className="mx-auto grid max-w-7xl gap-x-8 gap-y-6 px-4 py-8 text-sm leading-relaxed text-muted sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
            {STEPS.map((s) => (
              <li key={s.title}>
                <strong className="block text-ink">{s.title}</strong>
                {s.body}
              </li>
            ))}
          </ol>
        </section>
      </main>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt>{label}</dt>
      <span className="leader" aria-hidden="true" />
      <dd className={`num ${mono ? "font-mono text-[13px]" : "font-mono"}`}>{value}</dd>
    </div>
  );
}
