"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/cn";

export type LogLineKind = "ok" | "err" | "step" | "info";

export interface LogLine {
  kind: LogLineKind;
  text: string;
}

const KIND_STYLE: Record<LogLineKind, { glyph: string; className: string }> = {
  ok: { glyph: "✓", className: "text-[#4ade80]" },
  err: { glyph: "✗", className: "text-[#f87171]" },
  step: { glyph: "›", className: "text-[#93c5fd]" },
  info: { glyph: " ", className: "text-neutral-500" },
};

export interface LogStreamProps {
  /** Mono title in the chrome bar (operation / stream name). */
  title: string;
  lines: LogLine[];
  /** Right slot in the chrome bar (StatusBadge, elapsed time, onDark buttons…). */
  rightSlot?: ReactNode;
  /** Body max height; defaults to 320px. */
  maxHeight?: number;
  className?: string;
}

/**
 * Dark log frame: terminal-bg body, neutral-800 chrome bar with three dots,
 * mono 12.5px lines colored by kind, auto-scroll with pin-to-bottom toggle.
 */
export function LogStream({
  title,
  lines,
  rightSlot,
  maxHeight = 320,
  className,
}: LogStreamProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  // Distinguish programmatic scrolls from user scrolls.
  const programmatic = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  useEffect(() => {
    if (pinned) scrollToBottom();
  }, [lines, pinned, scrollToBottom]);

  function onScroll() {
    if (programmatic.current) return;
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setPinned(atBottom);
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[16px] border border-neutral-700 bg-terminal-bg",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-white/[0.07] bg-neutral-800 px-3.5 py-[9px]">
        <div aria-hidden className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-600" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-600" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-600" />
        </div>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">
          {title}
        </span>
        {rightSlot}
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin from bottom" : "Pin to bottom"}
          title={pinned ? "Pinned to bottom" : "Pin to bottom"}
          onClick={() => {
            const next = !pinned;
            setPinned(next);
            if (next) scrollToBottom();
          }}
          className={cn(
            "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400",
            pinned
              ? "bg-white/15 text-white"
              : "text-neutral-400 hover:bg-white/10 hover:text-white",
          )}
        >
          <ArrowDownToLine size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div
        ref={bodyRef}
        onScroll={onScroll}
        role="log"
        aria-label={title}
        style={{ maxHeight }}
        className="overflow-y-auto whitespace-pre-wrap break-all px-4 py-3.5 font-mono text-[12.5px] leading-[1.65] text-neutral-100"
      >
        {lines.map((line, i) => {
          const spec = KIND_STYLE[line.kind];
          return (
            <div key={i} className={spec.className}>
              {line.kind === "info" ? line.text : `${spec.glyph} ${line.text}`}
            </div>
          );
        })}
      </div>
    </div>
  );
}
