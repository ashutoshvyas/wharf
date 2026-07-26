"use client";

/**
 * Manage view (, design §5.8) — native Supabase Studio embedded in the
 * panel shell.
 *
 * The panel does NOT rebuild Studio (spec §6.3). Traefik's `wharf-auth@file`
 * middleware has already checked the panel session against /api/auth/verify
 * by the time this iframe's request reaches the Studio container, so Studio
 * loads with no second login.
 *
 * FRAME-BLOCKING FALLBACK: if Studio (or Kong) ever answers with
 * X-Frame-Options / CSP frame-ancestors, the iframe stays blank. We cannot
 * feature-detect that cross-origin, so a load watchdog assumes failure if no
 * `load` event arrives in time and swaps in the "open in a new tab" state —
 * which is zero-extra-login either way, just a tab instead of a frame
 * (spec §6.3).
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import type { InstanceDto } from "./api";

/** How long to wait for the iframe's load event before offering the fallback. */
const LOAD_TIMEOUT_MS = 12_000;

export function ManageView({ instance }: { instance: InstanceDto }) {
  const studioUrl = `https://${instance.studioSubdomain}`;
  const [blocked, setBlocked] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loaded.current) setBlocked(true);
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="-m-6 flex h-[calc(100vh-56px)] flex-col xl:-mx-8 xl:-my-7">
      {/* Slim strip keeps the panel identity above the embedded Studio. */}
      <div className="flex h-[46px] shrink-0 items-center gap-3.5 border-b border-neutral-200 bg-white px-5">
        <Link
          href="/databases"
          className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[13px] font-semibold text-cobalt-600 transition-colors hover:bg-cobalt-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
        >
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden />
          Fleet
        </Link>
        <span className="font-semibold">{instance.name}</span>
        <StatusBadge status="running" />
        <span className="truncate font-mono text-xs text-neutral-400 max-md:hidden">
          {instance.studioSubdomain} · session via forwardAuth — no Studio login
        </span>
        <span className="flex-1" />
        <ButtonLink
          href={studioUrl}
          target="_blank"
          rel="noopener"
          variant="secondary"
          size="sm"
        >
          Open in new tab
          <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
        </ButtonLink>
      </div>

      {blocked ? (
        <div className="flex flex-1 items-center justify-center bg-neutral-50 p-6">
          <div className="w-full max-w-[520px] rounded-md border border-neutral-200 bg-white shadow-sm">
            <div className="p-5">
              <Alert variant="info" title="Studio could not be embedded.">
                This instance&apos;s Studio did not load inside the panel — most
                likely it sends frame-blocking headers. Opening it in a new tab
                works identically and still requires no extra login: Traefik has
                already verified your panel session.
              </Alert>
            </div>
            <EmptyState
              icon={ExternalLink}
              message={`Open Studio for ${instance.name} in a new tab.`}
              action={
                <ButtonLink
                  href={studioUrl}
                  target="_blank"
                  rel="noopener"
                  variant="primary"
                  size="sm"
                >
                  Open Studio
                  <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
                </ButtonLink>
              }
            />
            <div className="border-t border-neutral-100 px-5 py-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => setBlocked(false)}>
                Try embedding again
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <iframe
          src={studioUrl}
          title={`Supabase Studio — ${instance.name}`}
          className="min-h-0 flex-1 border-0 bg-white"
          onLoad={() => {
            loaded.current = true;
          }}
        />
      )}
    </div>
  );
}
