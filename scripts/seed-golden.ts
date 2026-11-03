// Seeds the read-only golden workspace. Run manually with the service role key, after migrations
// 0001 to 0003 are applied:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/seed-golden.ts [--replace] [--dry-run]
// --replace deletes an existing golden workspace first. --dry-run only prints a summary.

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildGoldenSeed, insertGoldenSeed } from "../lib/services/goldenSeed";

async function main() {
  const args = new Set(process.argv.slice(2));
  const seed = buildGoldenSeed(randomUUID());
  const summary = seed.cases.map((c) => `${seed.labels[c.id].padEnd(16)} ${c.state.padEnd(15)} next=${c.next_step_kind ?? "-"}`);
  console.log(`Golden workspace ${seed.workspace.id} at virtual date ${seed.virtualDate}`);
  console.log(summary.join("\n"));
  console.log(`${seed.invoices.length} invoices, ${seed.steps.length} steps, ${seed.ledger.length} ledger rows, ${seed.audit.length} audit rows`);
  if (args.has("--dry-run")) return;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await insertGoldenSeed(db, seed, { replace: args.has("--replace") });
  console.log("Inserted.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
