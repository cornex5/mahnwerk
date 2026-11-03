// Prints the golden workspace seed as one SQL script (jsonb_populate_recordset per table), for
// applying through any SQL console without the service role key:
//   npx tsx scripts/seed-golden-sql.ts > golden.sql
import { randomUUID } from "node:crypto";
import { buildGoldenSeed } from "../lib/services/goldenSeed";

const seed = buildGoldenSeed(randomUUID());
const lit = (rows: unknown) => `'${JSON.stringify(rows).replace(/'/g, "''")}'::jsonb`;
// Explicit column lists (from the row keys) so column defaults (ids, timestamps) still apply.
const ins = (table: string, rows: unknown[]) => {
  if (rows.length === 0) return "";
  const keys = new Set<string>();
  for (const r of rows as Record<string, unknown>[]) for (const k of Object.keys(r)) keys.add(k);
  const cols = [...keys].map((k) => `"${k}"`).join(", ");
  return `insert into public.${table} (${cols}) select ${cols} from jsonb_populate_recordset(null::public.${table}, ${lit(rows)});\n`;
};

const out: string[] = [];
out.push("delete from public.workspaces where kind = 'golden';\n");
out.push(ins("workspaces", [seed.workspace]));
out.push(ins("creditors", [seed.creditor]));
out.push(ins("debtors", seed.debtors));
out.push(ins("invoices", seed.invoices.map(({ request_key, ...rest }) => (request_key === null ? rest : { ...rest, request_key }))));
out.push(ins("dunning_cases", seed.cases));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
out.push(ins("steps", seed.steps.map(({ exec_token, exec_started_at, ...rest }) => rest)));
out.push(ins("ledger", seed.ledger));
out.push(ins("audit_log", seed.audit));
process.stdout.write(out.join(""));
