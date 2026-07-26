"use client";

/**
 * Database-hosting card (, design §5.4 + prototype viewServerDetail()).
 *
 * Policy (owner decision 2026-07-24): servers are NEVER prepared up-front.
 * Most servers only host websites; preparation (Docker + Traefik + firewall)
 * happens automatically when the first database instance is provisioned onto
 * a server. So this card is informational for un-prepared servers,
 * and offers only an idempotent "Re-run setup" maintenance action once the
 * server already hosts databases.
 *
 * State machine: idle → running → succeeded | failed. Re-run posts
 * /api/servers/:id/bootstrap (202 {jobId} | 409 busy | 403), then the SSE log
 * (GET bootstrap-log) streams into the LogStream kit component.
 *
 * Refresh-resume: the hook connects to bootstrap-log once on mount — a job in
 * flight (or recently ended) replays its buffered lines; an unknown job ends
 * immediately with "No such job" and zero lines, which we treat as idle
 * silently. The log panel only renders once a line arrived or a POST started,
 * so the probe never flickers. A failed run keeps its log visible (design §6).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LogStream } from "@/components/ui/log-stream";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { ApiError, startBootstrap, type ServerDto } from "./api";
import { useJobStream } from "./use-job-stream";

export function BootstrapCard({
  server,
  role,
  onServerChanged,
}: {
  server: ServerDto;
  role: Role;
  /** Called on a successful run so the server query refetches (bootstrapped flips). */
  onServerChanged: () => void;
}) {
  const { toast } = useToast();
  const allowed = can(role, "server.bootstrap");

  const { status, lines, reconnect } = useJobStream(
    `/api/servers/${server.id}/bootstrap-log`,
  );

  // True once a POST kicked off a run in this session (before lines arrive).
  const [started, setStarted] = useState(false);
  // A stream session's terminal event is handled exactly once (probe of an
  // unknown job ends with zero lines and stays silent).
  const handledRef = useRef(false);

  const active = started || lines.length > 0;
  const running = active && status === "streaming";

  const start = useMutation({
    mutationFn: () => startBootstrap(server.id),
    onSuccess: () => {
      setStarted(true);
      reconnect(); // fresh stream; replay delivers anything already emitted
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.status === 409) {
        toast({ title: "Server busy", message: err.message, variant: "warning" });
      } else {
        toast({
          title: "Bootstrap failed to start",
          message: err.message,
          variant: "danger",
        });
      }
    },
  });

  useEffect(() => {
    if (status === "streaming") {
      handledRef.current = false;
      return;
    }
    if ((status !== "ok" && status !== "error") || handledRef.current) return;
    handledRef.current = true;
    if (!active) return; // mount probe found no job — stay idle silently
    if (status === "ok") {
      toast({ message: `${server.name} bootstrapped.`, variant: "success" });
      onServerChanged();
    } else {
      toast({ message: "Bootstrap failed — see log.", variant: "danger" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, active]);

  return (
    <Card className="p-[22px]">
      <SectionLabel className="mb-4">Database hosting</SectionLabel>
      <div className="flex flex-col gap-3.5">
        {server.bootstrapped ? (
          <>
            <Alert variant="success" title="Prepared for database hosting.">
              Docker + Compose installed, shared{" "}
              <code className="font-mono text-[12.5px]">traefik</code> network
              up, Traefik running with Let&apos;s Encrypt. Instance subdomains
              are routed automatically — no per-instance proxy or certificate
              work.
            </Alert>
            <Alert variant="warning" title="Wildcard DNS is required for this server.">
              Create{" "}
              <code className="whitespace-nowrap font-mono text-[12.5px]">
                *.&lt;your-domain&gt; → {server.host}
              </code>{" "}
              (A record) once — the apex is the domain this panel serves
              instances under. Every instance&apos;s two subdomains then resolve
              automatically, forever.
            </Alert>
          </>
        ) : (
          <Alert variant="info" title="Not a database host.">
            Most servers only host websites and need nothing here. This server
            is prepared automatically — Docker, Traefik and the firewall rules —
            the first time a database instance is provisioned onto it from{" "}
            <b>Databases → New instance</b>. It must have nothing else bound to
            ports 80 and 443.
          </Alert>
        )}

        {/* Manual runs are a maintenance affordance for servers that ALREADY
            host databases (re-uploading Traefik config picks up a changed
            panel URL or Let's Encrypt email). Servers are never prepared
            up-front — that happens on first provision (architecture §4.1). */}
        {allowed && server.bootstrapped ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={running || start.isPending}
              onClick={() => start.mutate()}
            >
              <Rocket size={14} strokeWidth={1.75} aria-hidden />
              Re-run setup
            </Button>
            <p className="mt-1.5 text-xs text-neutral-500">
              Idempotent — re-uploads Traefik config and verifies Docker, the
              shared network and the firewall. Running instances are untouched.
            </p>
            {!server.reachable ? (
              <p className="mt-1.5 text-xs text-neutral-500">
                Last connection attempt failed — this will retry SSH and report
                the outcome in the log below.
              </p>
            ) : null}
          </div>
        ) : null}

        {active ? (
          <LogStream
            title={`bootstrap · ${server.name}`}
            lines={lines}
            rightSlot={
              status === "disconnected" ? (
                <Button
                  variant="onDark"
                  size="sm"
                  className="h-[26px] rounded-[8px] px-2.5 text-xs"
                  onClick={reconnect}
                >
                  Reconnect
                </Button>
              ) : (
                <StatusBadge
                  status={
                    running ? "working" : status === "ok" ? "running" : "error"
                  }
                />
              )
            }
          />
        ) : null}
      </div>
    </Card>
  );
}
