"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, apiPost, errorMessage } from "./lib/api";
import { findGoldenWorkspaceId, findLatestOwnDemoId } from "./lib/data";
import { ConfigError, ensureSession } from "./lib/supabase";
import { Button, Notice } from "./ui";

export function StartButtons({ size = "lg", showExample = true }: { size?: "md" | "lg"; showExample?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"demo" | "example" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function startDemo() {
    setBusy("demo");
    setError(null);
    setInfo(null);
    try {
      const session = await ensureSession();
      try {
        const res = await apiPost<{ workspace: { id: string } }>("/api/workspaces", {});
        router.push(`/w/${res.workspace.id}`);
      } catch (err) {
        // The per-user cap is reached: resume the newest workspace instead of failing.
        if (err instanceof ApiError && err.code === "user_cap_reached") {
          const existing = await findLatestOwnDemoId(session.user.id);
          if (existing) {
            setInfo("You already have live demo workspaces. Opening your latest one.");
            router.push(`/w/${existing}`);
            return;
          }
        }
        throw err;
      }
    } catch (err) {
      setError(err instanceof ConfigError ? err.message : errorMessage(err));
      setBusy(null);
    }
  }

  async function openExample() {
    setBusy("example");
    setError(null);
    setInfo(null);
    try {
      await ensureSession();
      const id = await findGoldenWorkspaceId();
      if (!id) throw new Error("The example workspace has not been seeded yet.");
      router.push(`/w/${id}`);
    } catch (err) {
      setError(err instanceof ConfigError ? err.message : errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button variant="primary" size={size} loading={busy === "demo"} disabled={busy !== null} onClick={startDemo}>
          Try the live demo
        </Button>
        {showExample && (
          <Button variant="secondary" size={size} loading={busy === "example"} disabled={busy !== null} onClick={openExample}>
            See the example workspace
          </Button>
        )}
      </div>
      {info && <Notice tone="info">{info}</Notice>}
      {error && (
        <Notice tone="danger" title="Could not start">
          {error}
        </Notice>
      )}
    </div>
  );
}
