"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { addDays } from "@/lib/rules/dates";
import { apiPost, errorMessage, newNonce } from "./lib/api";
import { eur, fmtDate, parseEuroToCents } from "./lib/format";
import { Button, Dialog, Field, inputClass, Notice } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

export function NewInvoiceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // The dialog only mounts its children while open, so the form state resets on every open.
  return (
    <Dialog open={open} onClose={onClose} title="New invoice">
      <InvoiceForm onClose={onClose} />
    </Dialog>
  );
}

function InvoiceForm({ onClose }: { onClose: () => void }) {
  const { data, virtualDate, refresh } = useWorkspace();
  const router = useRouter();
  const [debtorId, setDebtorId] = useState("");
  const [amount, setAmount] = useState("1200.00");
  const [dueIn, setDueIn] = useState("14");
  const [description, setDescription] = useState("");
  const [fixedCalendarDue, setFixed] = useState(false);
  const [warning, setWarning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce] = useState(() => newNonce());

  const debtor = data.debtors.find((d) => d.id === (debtorId || data.debtors[0]?.id));
  const cents = parseEuroToCents(amount);
  const days = /^\d{1,3}$/.test(dueIn) ? Number(dueIn) : null;
  const valid = !!debtor && cents !== null && cents <= 5_000_000 && days !== null && days <= 365;
  const dueDate = days !== null ? addDays(virtualDate, days) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !debtor || cents === null || !dueDate) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ case: { id: string } }>(`/api/workspaces/${data.workspace.id}/invoices`, {
        debtorId: debtor.id,
        amountCents: cents,
        dueDate,
        fixedCalendarDue,
        defaultWarningPrinted: warning,
        ...(description.trim() ? { description: description.trim() } : {}),
        nonce,
      });
      await refresh();
      onClose();
      router.push(`/w/${data.workspace.id}/cases/${res.case.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
      <form onSubmit={submit} className="space-y-4">
        <Field label="Debtor" htmlFor="ni-debtor">
          <select id="ni-debtor" className={inputClass} value={debtor?.id ?? ""} onChange={(e) => setDebtorId(e.target.value)} disabled={busy}>
            {data.debtors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.type})
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (EUR)" htmlFor="ni-amount" hint={cents ? eur(cents) : "Enter an amount up to 50,000.00"}>
            <input id="ni-amount" inputMode="decimal" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} aria-invalid={cents === null} />
          </Field>
          <Field label="Due in (days)" htmlFor="ni-due" hint={dueDate ? `Due ${fmtDate(dueDate)}` : "Whole days, 0 to 365"}>
            <input id="ni-due" inputMode="numeric" className={inputClass} value={dueIn} onChange={(e) => setDueIn(e.target.value)} disabled={busy} aria-invalid={days === null} />
          </Field>
        </div>
        <Field label="Description (optional)" htmlFor="ni-desc">
          <input id="ni-desc" className={inputClass} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} placeholder="Logo design, November" />
        </Field>
        <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-xs font-medium text-muted">Legal facts on the invoice</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={fixedCalendarDue} onChange={(e) => setFixed(e.target.checked)} disabled={busy} />
            <span>Fixed calendar due date (BGB 286(2) no. 1): default starts the day after the due date.</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={warning} onChange={(e) => setWarning(e.target.checked)} disabled={busy} />
            <span>Invoice warns about default after 30 days (needed for consumers, BGB 286(3)).</span>
          </label>
        </fieldset>
        <p className="text-xs text-muted">
          This creates and sends an invoice in the PayPal sandbox. Tip: choose 1 day, then use the demo clock to watch the dunning ladder start.
        </p>
        {error && (
          <Notice tone="danger" title="Invoice not created">
            {error} You can retry safely: the same request is never created twice.
          </Notice>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
            Create and send invoice
          </Button>
        </div>
      </form>
  );
}
