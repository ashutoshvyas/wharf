"use client";

/**
 * Provisioning / teardown progress (, contract §5, design §5.7 + §4.2).
 *
 * The checklist is derived PURELY from the phase events on the SSE stream —
 * never from timers. Every phase boundary arrives as a line whose text begins
 * with a marker glyph followed by the exact phase id:
 *
 *     › prepare      → phase active
 *     ✓ prepare      → phase done
 *     ✗ health: …    → phase failed  (detail after the id is free-form)
 *
 * Anything else (including the bootstrap sub-steps that `prepare` expands
 * into, e.g. `› installDocker`) names an id that is not in the phase table and
 * is therefore ignored by the checklist while still showing in the log.
 *
 * `prepare` is emitted only for a server that is not yet a database host
 *, so it renders only once it has appeared in the stream.
 */
import { useEffect, useRef } from "react";
import { Check, Maximize2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { LogStream, type LogLine, type LogLineKind } from "@/components/ui/log-stream";
import { StatusBadge } from "@/components/ui/status-badge";
import { useJobStream } from "@/components/servers/use-job-stream";
import { instanceLogUrl, restoreLogUrl } from "./api";

export type JobKind = "provision" | "remove" | "restore";
export type PhaseState = "pending" | "active" | "done" | "failed";

interface PhaseDef {
  id: string;
  label: string;
  /** Rendered only when the phase actually appears in the stream. */
  optional?: boolean;
}

/** Contract §5 phase table, in order. */
export const PROVISION_PHASES: readonly PhaseDef[] = [
  { id: "validate", label: "Validate" },
  { id: "prepare", label: "Prepare server", optional: true },
  { id: "secrets", label: "Generate secrets" },
  { id: "render", label: "Render compose" },
  { id: "upload", label: "Upload to server" },
  { id: "start", label: "Start containers" },
  { id: "health", label: "Health checks" },
];

/** Contract §5 teardown phases (`stop → volumes → files → metadata`). */
export const REMOVE_PHASES: readonly PhaseDef[] = [
  { id: "stop", label: "Stop containers" },
  { id: "volumes", label: "Destroy volumes" },
  { id: "files", label: "Delete files" },
  { id: "metadata", label: "Release metadata" },
];

/** Restore phases (`upload → snapshot → restore → cleanup`, ). */
export const RESTORE_PHASES: readonly PhaseDef[] = [
  { id: "upload", label: "Upload backup" },
  { id: "snapshot", label: "Snapshot current data" },
  { id: "restore", label: "Restore" },
  { id: "cleanup", label: "Clean up" },
];

export interface PhaseRow {
  id: string;
  label: string;
  state: PhaseState;
}

/** `› phase`, `✓ phase`, `✗ phase: detail` — the id must start the line. */
const PHASE_RE = /^([›✓✗])\s*([A-Za-z][A-Za-z0-9_-]*)/;

const GLYPH_STATE: Record<string, PhaseState> = {
  "›": "active",
  "✓": "done",
  "✗": "failed",
};

export function phaseDefs(kind: JobKind): readonly PhaseDef[] {
  if (kind === "remove") return REMOVE_PHASES;
  if (kind === "restore") return RESTORE_PHASES;
  return PROVISION_PHASES;
}

/**
 * Fold the stream into checklist state. Later events win, so a phase that is
 * re-entered (retry inside one stream) goes back to `active`.
 */
export function derivePhases(lines: LogLine[], kind: JobKind): PhaseRow[] {
  const defs = phaseDefs(kind);
  const known = new Set(defs.map((d) => d.id));
  const seen = new Map<string, PhaseState>();

  for (const line of lines) {
    const match = PHASE_RE.exec(line.text.trim());
    if (!match) continue;
    const glyph = match[1];
    const id = match[2];
    if (!glyph || !id) continue;
    if (!known.has(id)) continue; // nested sub-step or unrelated line
    seen.set(id, GLYPH_STATE[glyph] ?? "active");
  }

  return defs
    .filter((d) => !d.optional || seen.has(d.id))
    .map((d) => ({ id: d.id, label: d.label, state: seen.get(d.id) ?? "pending" }));
}

const TAIL_KIND: Record<string, LogLineKind> = {
  "✓": "ok",
  "✗": "err",
  "›": "step",
};

/**
 * Turn a stored `lastActionLog` tail into renderable lines, classifying by the
 * same glyph convention the stream uses.
 */
export function parseLogTail(tail: string | null | undefined): LogLine[] {
  if (!tail) return [];
  return tail
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((raw) => {
      const trimmed = raw.trimEnd();
      const glyph = trimmed.trimStart().charAt(0);
      const kind = TAIL_KIND[glyph];
      return kind
        ? { kind, text: stripGlyph(trimmed) }
        : { kind: "info" as const, text: trimmed };
    });
}

/**
 * The engine emits the glyph inside the line text and LogStream renders its
 * own glyph per kind — strip ours so lines don't read `› › prepare`.
 */
export function stripGlyph(text: string): string {
  return text.replace(/^\s*[›✓✗]\s*/, "");
}

function displayLines(lines: LogLine[]): LogLine[] {
  return lines.map((l) =>
    l.kind === "info" ? l : { kind: l.kind, text: stripGlyph(l.text) },
  );
}

const STEP_STATE_CLASSES: Record<PhaseState, { row: string; marker: string }> = {
  pending: { row: "text-neutral-500", marker: "bg-neutral-100 text-neutral-400" },
  done: { row: "text-ink", marker: "bg-[rgba(46,158,107,0.12)] text-success" },
  active: {
    row: "text-ink font-semibold",
    marker: "bg-coral-50 text-coral-600",
  },
  failed: { row: "text-ink", marker: "bg-[rgba(216,73,60,0.1)] text-danger" },
};

export function PhaseChecklist({
  phases,
  compact = false,
  className,
}: {
  phases: PhaseRow[];
  compact?: boolean;
  className?: string;
}) {
  return (
    <ol
      className={cn(
        "flex flex-col",
        compact ? "gap-[5px]" : "gap-[7px]",
        className,
      )}
    >
      {phases.map((phase, i) => {
        const style = STEP_STATE_CLASSES[phase.state];
        return (
          <li
            key={phase.id}
            className={cn(
              "flex items-center gap-2.5",
              compact ? "text-[12.5px]" : "text-[13.5px]",
              style.row,
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full text-[11px]",
                compact ? "h-[17px] w-[17px]" : "h-5 w-5",
                style.marker,
              )}
            >
              {phase.state === "done" ? (
                <Check size={11} strokeWidth={2.5} />
              ) : phase.state === "failed" ? (
                <X size={11} strokeWidth={2.5} />
              ) : phase.state === "active" ? (
                <span className="h-2 w-2 animate-spark-fast rounded-full bg-coral-500" />
              ) : (
                i + 1
              )}
            </span>
            <span className="truncate">{phase.label}</span>
            <span className="sr-only">
              {phase.state === "done"
                ? " — done"
                : phase.state === "failed"
                  ? " — failed"
                  : phase.state === "active"
                    ? " — in progress"
                    : " — pending"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export interface ProvisionProgressProps {
  instanceId: string;
  /** `provision` (also retry) or `remove` — picks the phase table. */
  kind: JobKind;
  /** Mono title for the log chrome bar, e.g. `sb_4f2a · vps-01`. */
  title: string;
  /** Card-embedded variant: tighter checklist + short log body. */
  compact?: boolean;
  /** Fired once per terminal event, only when the stream actually had lines. */
  onTerminal?: (status: "ok" | "error") => void;
  /** Renders an expand button in the compact variant. */
  onExpand?: () => void;
  className?: string;
}

export function ProvisionProgress({
  instanceId,
  kind,
  title,
  compact = false,
  onTerminal,
  onExpand,
  className,
}: ProvisionProgressProps) {
  const { status, lines, reconnect } = useJobStream(
    kind === "restore" ? restoreLogUrl(instanceId) : instanceLogUrl(instanceId),
  );
  const phases = derivePhases(lines, kind);
  const handledRef = useRef(false);

  // Terminal events fire exactly once per stream session. A stream that ends
  // with zero lines is an evicted / unknown job (e.g. after a refresh) — stay
  // silent rather than reporting a failure that never happened.
  useEffect(() => {
    if (status === "streaming") {
      handledRef.current = false;
      return;
    }
    if (status !== "ok" && status !== "error") return;
    if (handledRef.current) return;
    handledRef.current = true;
    if (lines.length === 0) return;
    onTerminal?.(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, lines.length]);

  const badge =
    status === "streaming"
      ? kind === "remove"
        ? "removing"
        : kind === "restore"
          ? "restoring"
          : "provisioning"
      : status === "ok"
        ? "running"
        : "error";

  return (
    <div className={cn("flex flex-col", compact ? "gap-2.5" : "gap-3.5", className)}>
      {phases.length > 0 ? (
        <PhaseChecklist phases={phases} compact={compact} />
      ) : (
        <p className={cn("text-neutral-500", compact ? "text-[12.5px]" : "text-[13px]")}>
          {status === "streaming"
            ? "Waiting for the first phase…"
            : "No phase events on this stream."}
        </p>
      )}

      <LogStream
        title={title}
        lines={displayLines(lines)}
        maxHeight={compact ? 130 : 260}
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
            <div className="flex items-center gap-2">
              <StatusBadge status={badge} />
              {compact && onExpand ? (
                <button
                  type="button"
                  aria-label="Expand log"
                  title="Expand"
                  onClick={onExpand}
                  className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
                >
                  <Maximize2 size={13} strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          )
        }
      />

      {status === "disconnected" ? (
        <p className="text-xs text-neutral-500">
          The log stream dropped. The operation keeps running on the server —
          reconnect to follow it.
        </p>
      ) : null}
    </div>
  );
}
