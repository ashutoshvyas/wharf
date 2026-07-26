import { describe, expect, it } from "vitest";
import {
  bufferedLines,
  endJob,
  isJobActive,
  publish,
  sseResponse,
  startJob,
  subscribe,
} from "./stream";

const jid = (s: string) => `test:${s}:${Math.random().toString(36).slice(2)}`;

describe("job stream", () => {
  it("replays buffered events to late subscribers, then streams live", () => {
    const id = jid("replay");
    startJob(id);
    publish(id, "step", "one");
    publish(id, "ok", "two");

    const seen: string[] = [];
    const unsub = subscribe(
      id,
      (ev) => seen.push(`${ev.kind}:${ev.line}`),
      () => seen.push("END"),
    );
    expect(seen).toEqual(["step:one", "ok:two"]);

    publish(id, "err", "three");
    expect(seen).toEqual(["step:one", "ok:two", "err:three"]);
    unsub();
    publish(id, "info", "four");
    expect(seen).toHaveLength(3);
  });

  it("delivers the end marker exactly once and to late subscribers", () => {
    const id = jid("end");
    startJob(id);
    publish(id, "ok", "done-ish");
    let end: string | null = null;
    subscribe(id, () => {}, (e) => (end = e.status));
    endJob(id, "ok");
    expect(end).toBe("ok");
    // late subscriber after end: gets replay + end synchronously
    const late: string[] = [];
    subscribe(id, (ev) => late.push(ev.line), (e) => late.push(`END:${e.status}`));
    expect(late).toEqual(["done-ish", "END:ok"]);
    expect(isJobActive(id)).toBe(false);
  });

  it("caps the ring buffer at 500 events", () => {
    const id = jid("cap");
    startJob(id);
    for (let i = 0; i < 620; i++) publish(id, "info", `l${i}`);
    const lines = bufferedLines(id);
    expect(lines).toHaveLength(500);
    expect(lines[0]?.line).toBe("l120");
    expect(lines[499]?.line).toBe("l619");
  });

  it("refuses to double-start a live job, allows restart after end", () => {
    const id = jid("dupe");
    startJob(id);
    expect(() => startJob(id)).toThrow(/already running/);
    endJob(id, "error");
    expect(() => startJob(id)).not.toThrow();
  });

  it("publish/end on unknown ids are no-ops", () => {
    expect(() => publish(jid("ghost"), "ok", "x")).not.toThrow();
    expect(() => endJob(jid("ghost"), "ok")).not.toThrow();
  });

  it("sseResponse emits events then the end marker and closes", async () => {
    const id = jid("sse");
    startJob(id);
    publish(id, "step", "hello");
    const res = sseResponse(id);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // finish the job so the stream closes
    publish(id, "ok", "world");
    endJob(id, "ok");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain('data: {"ts"');
    expect(text).toContain('"line":"hello"');
    expect(text).toContain('"line":"world"');
    expect(text).toContain('data: {"done":true,"status":"ok"}');
  });

  it("sseResponse for an unknown job ends immediately with an error marker", async () => {
    const res = sseResponse("bootstrap:nope-never-existed");
    const text = await new Response(res.body).text();
    expect(text).toContain('"done":true');
    expect(text).toContain('"status":"error"');
  });
});
