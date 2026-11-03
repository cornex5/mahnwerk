// Static checks on 0003_service_layer.sql (offline, no database needed).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const sql = readFileSync(path.join(__dirname, "0003_service_layer.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");
const fns = [...code.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);

describe("0003_service_layer.sql", () => {
  it("defines the service functions", () => {
    expect(fns.sort()).toEqual(["mw_complete_step", "mw_consume_reminder_quota", "mw_create_demo_workspace", "mw_decide_step", "mw_finalize_invoice"]);
  });

  it("restricts every function to the service role", () => {
    for (const f of fns) {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated;`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role;`));
    }
    expect(code).not.toMatch(/security definer/);
  });

  it("pins search_path on every function", () => {
    expect((code.match(/set search_path = ''/g) ?? []).length).toBe(fns.length);
  });

  it("keeps the approval invariant and the quota cap in SQL", () => {
    expect(code).toMatch(/approved_by is null or v_step\.approved_at is null/);
    expect(code).toMatch(/least\(greatest\(p_max, 0\), 2\)/);
    expect(code).toMatch(/where public\.api_quota\.reminders_used < v_max/);
    expect(code).toMatch(/pg_advisory_xact_lock/);
  });

  it("is additive (no drop, delete or truncate) and adds the uniqueness guards", () => {
    expect(code).not.toMatch(/\b(drop|delete|truncate)\b/i);
    expect(code).toMatch(/create unique index if not exists invoices_request_key_unique/);
    expect(code).toMatch(/create unique index if not exists steps_one_pending_dunning_step_per_case/);
  });
});
