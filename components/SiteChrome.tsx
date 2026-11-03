import Link from "next/link";
import type { ReactNode } from "react";

export const GITHUB_URL = "https://github.com/cornex5/mahnwerk";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2.5 font-semibold tracking-tight ${className}`} aria-label="Mahnwerk home">
      <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-md border border-brand-line font-mono text-base text-brand">
        §
      </span>
      <span className="text-[17px]">Mahnwerk</span>
    </Link>
  );
}

export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Logo />
        {children}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-muted sm:px-6 md:flex-row md:items-start md:justify-between">
        <p className="max-w-3xl">
          Hackathon demo on the PayPal sandbox. Not legal advice.
        </p>
        <p className="flex shrink-0 items-center gap-3">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
            GitHub
          </a>
          <span aria-hidden="true">/</span>
          <span>MIT License</span>
        </p>
      </div>
    </footer>
  );
}
