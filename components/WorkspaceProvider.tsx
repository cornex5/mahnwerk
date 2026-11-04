"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildViews, totalsOf, virtualDateOf, type CaseView, type Totals } from "./lib/claim";
import { loadWorkspaceData, NotFoundError } from "./lib/data";
import { ConfigError, ensureSession } from "./lib/supabase";
import type { StepRow, WorkspaceData } from "./lib/types";
import { Button, ErrorState, Skeleton } from "./ui";
import Link from "next/link";

interface Ctx {
  data: WorkspaceData;
  uid: string;
  virtualDate: string;
  readOnly: boolean;
  readOnlyReason: "golden" | "not_owner" | "expired" | null;
  views: CaseView[];
  totals: Totals;
  proposed: StepRow[];
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<Ctx | null>(null);

export function useWorkspace(): Ctx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}

type Phase = { kind: "loading" } | { kind: "error"; message: string; notFound: boolean; config: boolean } | { kind: "ready"; data: WorkspaceData; uid: string; at: number };

export function WorkspaceProvider({ id, children, placeholder }: { id: string; children: ReactNode; placeholder?: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const uidRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const session = await ensureSession();
        uidRef.current = session.user.id;
        const data = await loadWorkspaceData(id);
        if (alive) setPhase({ kind: "ready", data, uid: session.user.id, at: Date.now() });
      } catch (err) {
        if (!alive) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not load the workspace",
          notFound: err instanceof NotFoundError,
          config: err instanceof ConfigError,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  const refresh = useCallback(async () => {
    try {
      const data = await loadWorkspaceData(id);
      setPhase((p) => (p.kind === "ready" ? { kind: "ready", data, uid: p.uid, at: Date.now() } : p));
    } catch {
      // Keep showing the last good data; the next refresh may succeed.
    }
  }, [id]);

  const isReady = phase.kind === "ready";
  const isGolden = phase.kind === "ready" && phase.data.workspace.kind === "golden";
  useEffect(() => {
    if (!isReady || isGolden) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => clearInterval(t);
  }, [isReady, isGolden, refresh]);

  const value = useMemo<Ctx | null>(() => {
    if (phase.kind !== "ready") return null;
    const { data, uid, at } = phase;
    const virtualDate = virtualDateOf(data.workspace);
    const views = buildViews(data, virtualDate);
    const ws = data.workspace;
    const expired = ws.expires_at !== null && Date.parse(ws.expires_at) <= at;
    const readOnlyReason = ws.kind === "golden" ? "golden" : ws.owner_uid !== uid ? "not_owner" : expired ? "expired" : null;
    return {
      data,
      uid,
      virtualDate,
      readOnly: readOnlyReason !== null,
      readOnlyReason,
      views,
      totals: totalsOf(views, data.ledger),
      proposed: data.steps.filter((s) => s.status === "proposed"),
      refresh,
    };
  }, [phase, refresh]);

  if (phase.kind === "loading") {
    if (placeholder) return <div aria-busy="true">{placeholder}</div>;
    return (
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-8 sm:px-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading workspace</span>
        <Skeleton className="h-10 w-1/3" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (phase.kind === "error") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <ErrorState
          title={phase.notFound ? "Workspace not found" : phase.config ? "Backend not configured" : "Could not load the workspace"}
          message={phase.message}
          onRetry={phase.notFound ? undefined : () => setAttempt((n) => n + 1)}
        />
        <div className="mt-4">
          <Link href="/">
            <Button variant="secondary">Back to start</Button>
          </Link>
        </div>
      </div>
    );
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
