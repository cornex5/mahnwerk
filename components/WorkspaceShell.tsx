"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { fmtDate } from "./lib/format";
import { SiteHeader } from "./SiteChrome";
import { StartButtons } from "./StartButtons";
import { Badge, cx, Notice } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

export function WorkspaceShell({ id, children }: { id: string; children: ReactNode }) {
  const { data, virtualDate, readOnlyReason, proposed } = useWorkspace();
  const pathname = usePathname();
  const base = `/w/${id}`;
  const tabs = [
    { href: base, label: "Dashboard", active: pathname === base || pathname.startsWith(`${base}/cases`) },
    { href: `${base}/queue`, label: "Approval queue", active: pathname.startsWith(`${base}/queue`), count: proposed.length },
  ];
  return (
    <>
      <SiteHeader>
        <div className="flex items-center gap-2 text-sm">
          <span className="hidden max-w-[16rem] truncate font-medium sm:inline">{data.workspace.name}</span>
          {data.workspace.kind === "golden" ? <Badge tone="info">Read-only example</Badge> : <Badge tone="brand">Sandbox demo</Badge>}
          <span className="num rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs" title="Virtual date of this workspace">
            {fmtDate(virtualDate)}
          </span>
        </div>
      </SiteHeader>
      {readOnlyReason === "golden" && (
        <div className="border-b border-info-line bg-info-soft">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 text-sm sm:px-6 md:flex-row md:items-center md:justify-between">
            <p>
              <strong>Read-only example workspace.</strong> The date is fixed at {fmtDate(virtualDate)} and every action is disabled. Browse the cases, letters and calculations, or start your own sandbox to click through the full flow.
            </p>
            <StartButtons size="md" showExample={false} />
          </div>
        </div>
      )}
      {readOnlyReason === "not_owner" && (
        <div className="mx-auto max-w-7xl px-4 pt-4 sm:px-6">
          <Notice tone="warn" title="Read-only">
            This workspace belongs to another browser session. You can look, but not change anything.
          </Notice>
        </div>
      )}
      {readOnlyReason === "expired" && (
        <div className="mx-auto max-w-7xl px-4 pt-4 sm:px-6">
          <Notice tone="warn" title="This demo workspace has expired">
            Demo workspaces last 48 hours. Go back to the start page to create a fresh one.
          </Notice>
        </div>
      )}
      <nav aria-label="Workspace" className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl gap-1 px-4 sm:px-6">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={t.active ? "page" : undefined}
              className={cx(
                "-mb-px flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium",
                t.active ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
              )}
            >
              {t.label}
              {t.count ? <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-fg num">{t.count}</span> : null}
            </Link>
          ))}
        </div>
      </nav>
      <main id="main" className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">
        {children}
      </main>
    </>
  );
}
