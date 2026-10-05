/**
 * In-memory job event streaming — the shared plumbing for long-running
 * SSH jobs, including bootstrap, provisioning and teardown.
 *
 * Design (architecture §4.3):
 *  - pub/sub keyed by jobId, with a ring buffer (last {@link BUFFER_CAP}
 *    events) replayed to late subscribers;
 *  - jobs are explicitly ended with a status; ended jobs are kept for
 *    {@link ENDED_TTL_MS} so a page refresh can still read the outcome;
 *  - in-process only — the panel is a single long-lived node process
 *    (architecture §2), same argument as lib/rate-limit.ts.
 *
 * Job id conventions: `bootstrap:{serverId}`, `provision:{instanceId}`,
 * `remove:{instanceId}` — one live job per id (start() throws if active).
 *
 * SSE wire format (consumed by hooks in the UI):
 *  - each event: `data: {"ts":..., "kind":"step|ok|err|info", "line":"..."}`
 *  - terminal:   `data: {"done":true, "status":"ok|error"}` then the stream closes
 *  - heartbeat comment `: hb` every 15s to defeat proxy buffering.
 */

export type JobEventKind = "step" | "ok" | "err" | "info";

export interface JobEvent {
  ts: number;
  kind: JobEventKind;
  line: string;
}

export interface JobEnd {
  done: true;
  status: "ok" | "error";
}

type Subscriber = {
  onEvent: (ev: JobEvent) => void;
  onEnd: (end: JobEnd) => void;
};

interface Job {
  events: JobEvent[];
  subscribers: Set<Subscriber>;
  ended: JobEnd | null;
  endedAt: number | null;
}

const BUFFER_CAP = 500;
const ENDED_TTL_MS = 60 * 60 * 1000;

const jobs = new Map<string, Job>();

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.ended && job.endedAt !== null && now - job.endedAt > ENDED_TTL_MS) {
      jobs.delete(id);
    }
  }
}

/** Start (or restart) a job. Throws if a live job with this id exists. */
export function startJob(jobId: string): void {
  sweep();
  const existing = jobs.get(jobId);
  if (existing && !existing.ended) {
    throw new Error(`Job already running: ${jobId}`);
  }
  jobs.set(jobId, { events: [], subscribers: new Set(), ended: null, endedAt: null });
}

export function isJobActive(jobId: string): boolean {
  const job = jobs.get(jobId);
  return !!job && !job.ended;
}

export function publish(jobId: string, kind: JobEventKind, line: string): void {
  const job = jobs.get(jobId);
  if (!job || job.ended) return;
  const ev: JobEvent = { ts: Date.now(), kind, line };
  job.events.push(ev);
  if (job.events.length > BUFFER_CAP) job.events.splice(0, job.events.length - BUFFER_CAP);
  for (const sub of job.subscribers) sub.onEvent(ev);
}

export function endJob(jobId: string, status: JobEnd["status"]): void {
  const job = jobs.get(jobId);
  if (!job || job.ended) return;
  job.ended = { done: true, status };
  job.endedAt = Date.now();
  for (const sub of job.subscribers) sub.onEnd(job.ended);
  job.subscribers.clear();
}

/**
 * Subscribe with replay. Returns an unsubscribe function. If the job has
 * already ended, the buffer plus the end marker are delivered synchronously.
 * Unknown job ids deliver nothing and return a no-op (callers decide how to
 * present "no such job").
 */
export function subscribe(
  jobId: string,
  onEvent: Subscriber["onEvent"],
  onEnd: Subscriber["onEnd"],
): () => void {
  const job = jobs.get(jobId);
  if (!job) return () => {};
  for (const ev of job.events) onEvent(ev);
  if (job.ended) {
    onEnd(job.ended);
    return () => {};
  }
  const sub: Subscriber = { onEvent, onEnd };
  job.subscribers.add(sub);
  return () => job.subscribers.delete(sub);
}

/** Snapshot of a job's buffered lines (e.g. to persist a log tail). */
export function bufferedLines(jobId: string): JobEvent[] {
  return jobs.get(jobId)?.events.slice() ?? [];
}

/**
 * Build a text/event-stream Response for a job — for App Router route
 * handlers (`export const dynamic = "force-dynamic"` on the route).
 * If the job id is unknown, emits a single {done, status:"error"} marker.
 */
export function sseResponse(jobId: string): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      if (!jobs.has(jobId)) {
        send({ done: true, status: "error", line: "No such job" });
        close();
        return;
      }

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": hb\n\n"));
        } catch {
          close();
        }
      }, 15_000);

      unsubscribe = subscribe(
        jobId,
        (ev) => send(ev),
        (end) => {
          send(end);
          close();
        },
      );
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
