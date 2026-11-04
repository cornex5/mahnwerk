import { createClient } from "@supabase/supabase-js";
import { eur, fmtDate, STATE_LABEL } from "./lib/format";
import type { CaseState } from "./lib/types";

interface Row {
  number: string | null;
  debtor: string;
  type: string;
  principal: number;
  due: string;
  state: CaseState;
}

/**
 * Server-rendered summary of the read-only example workspace. It is what a crawler or an AI judge sees
 * before the interactive view has loaded (the example workspace is public data under row level security).
 * Returns null for any other workspace.
 */
export async function ExampleSummary({ id }: { id: string }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const ws = await sb.from("workspaces").select("id, kind, name").eq("id", id).maybeSingle();
  if (ws.error || !ws.data || ws.data.kind !== "golden") return null;
  const [inv, deb, cases] = await Promise.all([
    sb.from("invoices").select("id, debtor_id, number, due_date, principal_cents").eq("workspace_id", id).order("number"),
    sb.from("debtors").select("id, name, type").eq("workspace_id", id),
    sb.from("dunning_cases").select("invoice_id, state").eq("workspace_id", id),
  ]);
  if (inv.error || deb.error || cases.error) return null;
  const caseByInvoice = new Map((cases.data ?? []).map((c) => [c.invoice_id as string, c]));
  const debtorById = new Map((deb.data ?? []).map((d) => [d.id as string, d]));
  const rows: Row[] = (inv.data ?? []).map((i) => {
    const c = caseByInvoice.get(i.id as string);
    const d = debtorById.get(i.debtor_id as string);
    return {
      number: i.number as string | null,
      debtor: (d?.name as string) ?? "Debtor",
      type: (d?.type as string) ?? "",
      principal: i.principal_cents as number,
      due: i.due_date as string,
      state: (c?.state as CaseState) ?? "open",
    };
  });
  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Example workspace (read-only)</h1>
      <p className="max-w-3xl text-sm text-muted">
        Seven fictional invoices at a fixed virtual date of 20 Nov 2026, in different stages of dunning. The interactive view with claim calculations, letters and the approval queue is loading. Amounts and interest are computed by a rules engine in plain code (BGB 286, 288, 367); Claude only drafts the letter wording; a human approves every step.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-left text-xs font-medium text-muted">
            <tr>
              <th scope="col" className="py-1.5">Invoice</th>
              <th scope="col" className="py-1.5">Debtor</th>
              <th scope="col" className="py-1.5 text-right">Principal</th>
              <th scope="col" className="py-1.5 pl-4">Due</th>
              <th scope="col" className="py-1.5 pl-4">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.number}>
                <td className="py-2 font-mono text-xs">{r.number}</td>
                <td className="py-2">
                  {r.debtor} <span className="text-muted">({r.type})</span>
                </td>
                <td className="num py-2 text-right font-mono">{eur(r.principal)}</td>
                <td className="py-2 pl-4">{fmtDate(r.due)}</td>
                <td className="py-2 pl-4">{STATE_LABEL[r.state] ?? r.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
