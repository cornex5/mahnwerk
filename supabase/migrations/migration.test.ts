// Static checks on the SQL migration (offline, no database needed).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DE_BASE_RATES, DE_RULESET } from "@/lib/rules/de";

const sql = readFileSync(path.join(__dirname, "0001_init.sql"), "utf8");
const tables = [...sql.matchAll(/create table public\.(\w+)/g)].map((m) => m[1]);

describe("0001_init.sql", () => {
  it("creates every required table", () => {
    for (const t of [
      "workspaces", "creditors", "debtors", "invoices", "ledger", "dunning_cases", "steps",
      "rule_sets", "base_rates", "paypal_events", "audit_log", "ai_runs", "api_quota",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("enables RLS on every table it creates", () => {
    for (const t of tables) expect(sql).toContain(`alter table public.${t} enable row level security;`);
  });

  it("makes paypal_events.event_id unique and ledger refs unique per invoice", () => {
    expect(sql).toMatch(/event_id text not null unique/);
    expect(sql).toMatch(/unique \(invoice_id, kind, paypal_ref\)/);
  });

  it("blocks UPDATE, DELETE and TRUNCATE on audit_log and grants no write policy", () => {
    expect(sql).toMatch(/before update or delete on public\.audit_log/);
    expect(sql).toMatch(/before truncate on public\.audit_log/);
    expect(sql).not.toMatch(/on public\.audit_log\s+for (insert|update|delete|all)/);
  });

  it("stores money only as bigint cents", () => {
    const moneyCols = [...sql.matchAll(/^\s+(\w*_cents)\s+(\w+)/gm)];
    expect(moneyCols.length).toBeGreaterThan(4);
    for (const m of moneyCols) expect(m[2]).toBe("bigint");
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/^\s+\w+\s+(numeric|money|real|double precision|float\d*)\b/m);
  });

  it("gives clients no write policy on money tables", () => {
    for (const t of ["invoices", "ledger", "dunning_cases", "steps", "paypal_events", "ai_runs", "api_quota"]) {
      expect(sql).not.toMatch(new RegExp(`on public\\.${t}\\s+for (insert|update|delete|all)`));
    }
  });

  it("seeds the base rate exactly like lib/rules/de.ts", () => {
    const rows = [...sql.matchAll(/\('DE', '(\d{4}-\d{2}-\d{2})', (-?\d+), '/g)].map((m) => ({ valid_from: m[1], rateBp: Number(m[2]) }));
    expect(rows).toEqual(DE_BASE_RATES.map((r) => ({ valid_from: r.valid_from, rateBp: r.rateBp })));
  });

  it("seeds rule set params exactly like DE_RULESET", () => {
    const m = /'DE', '2026-07-01', '(\{[\s\S]*?\})'::jsonb/.exec(sql);
    expect(m).not.toBeNull();
    const params = JSON.parse(m![1]);
    expect(params).toEqual({
      marginBp: DE_RULESET.marginBp,
      flatFeeCents: DE_RULESET.flatFeeCents,
      dayCountBasis: DE_RULESET.dayCountBasis,
      thirtyDayRuleDays: 30, // as first seeded; migration 0006 moves it to 31
      waitingDays: DE_RULESET.waitingDays,
      allocationOrder: [...DE_RULESET.allocationOrder],
    });
  });

  it("restricts the transition function to the service role", () => {
    expect(sql).toMatch(/revoke all on function public\.mw_transition_case[^;]+from public, anon, authenticated;/);
  });
});

describe("0002_fee_invoice_step_unique.sql", () => {
  const sql2 = readFileSync(path.join(__dirname, "0002_fee_invoice_step_unique.sql"), "utf8");
  it("allows at most one fee_invoice step per case", () => {
    expect(sql2).toMatch(/create unique index steps_one_fee_invoice_per_case\s+on public\.steps \(case_id\)\s+where kind = 'fee_invoice';/);
  });
  it("is only additive (no drop, alter or delete)", () => {
    const code = sql2.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\b(drop|alter|delete|truncate|update)\b/i);
  });
});

describe("repository text rules", () => {
  it("contains no em dash in source, SQL or docs", () => {
    const root = path.resolve(__dirname, "../..");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".git"].includes(name)) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|sql|md|mjs|json|css)$/.test(name) && name !== "package-lock.json") {
          if (readFileSync(p, "utf8").includes(String.fromCharCode(0x2014))) bad.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });
});
