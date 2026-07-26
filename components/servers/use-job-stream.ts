"use client";

/**
 * useJobStream — EventSource consumer for the job SSE endpoints
 * (lib/jobs/stream.ts wire format):
 *
 *  - each event:  data: {"ts","kind":"step|ok|err|info","line"}
 *  - terminal:    data: {"done":true,"status":"ok|error"} then the stream closes
 *  - buffered lines are replayed automatically on (re)connect, so every
 *    reconnect resets the local buffer instead of appending duplicates.
 *
 * `url === null` keeps the hook idle. Transport failures surface as
 * `disconnected` (native auto-retry is suppressed); call `reconnect()` to
 * open a fresh stream. Client buffer is capped at {@link MAX_LINES} lines.
 */
import { useCallback, useEffect, useState } from "react";
import type { LogLine, LogLineKind } from "@/components/ui/log-stream";

const MAX_LINES = 600;

export type JobStreamStatus =
  | "idle"
  | "streaming"
  | "ok"
  | "error"
  | "disconnected";

const KINDS: readonly LogLineKind[] = ["ok", "err", "step", "info"];

export function useJobStream(url: string | null): {
  status: JobStreamStatus;
  lines: LogLine[];
  /** Close (if open) and open a fresh stream; replay refills the buffer. */
  reconnect: () => void;
} {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<JobStreamStatus>("idle");
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!url) {
      setLines([]);
      setStatus("idle");
      return;
    }

    setLines([]);
    setStatus("streaming");
    const es = new EventSource(url);
    let done = false;

    es.onmessage = (ev: MessageEvent<string>) => {
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return; // ignore malformed frames
      }
      if (!payload || typeof payload !== "object") return;
      const p = payload as {
        done?: boolean;
        status?: string;
        kind?: string;
        line?: string;
      };

      if (p.done === true) {
        done = true;
        es.close();
        setStatus(p.status === "ok" ? "ok" : "error");
        return;
      }

      const kind: LogLineKind = KINDS.includes(p.kind as LogLineKind)
        ? (p.kind as LogLineKind)
        : "info";
      const text = typeof p.line === "string" ? p.line : "";
      setLines((prev) => {
        const next =
          prev.length >= MAX_LINES
            ? prev.slice(prev.length - MAX_LINES + 1)
            : prev.slice();
        next.push({ kind, text });
        return next;
      });
    };

    es.onerror = () => {
      if (done) return;
      done = true;
      es.close(); // suppress native auto-retry; the UI offers reconnect()
      setStatus("disconnected");
    };

    return () => {
      done = true;
      es.close();
    };
  }, [url, epoch]);

  const reconnect = useCallback(() => setEpoch((e) => e + 1), []);

  return { status, lines, reconnect };
}
