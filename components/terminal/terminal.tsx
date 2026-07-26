"use client";

/**
 * Browser SSH terminal (, design §4.2 Terminal + prototype
 * serverTerminal()): xterm.js + FitAddon inside the dark LogStream-style
 * frame — neutral-800 chrome bar (three dots, mono title, connection
 * StatusBadge, session duration, onDark Disconnect), terminal-bg body.
 *
 * Wire protocol lives in use-terminal-socket.ts (docs/terminal-protocol.md).
 */
import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_THEME,
} from "./theme";
import { useTerminalSocket, type TerminalStatus } from "./use-terminal-socket";

const RESIZE_DEBOUNCE_MS = 150;

const STATUS_BADGE: Record<
  TerminalStatus,
  { status: "working" | "running" | "stopped"; label: string }
> = {
  connecting: { status: "working", label: "connecting…" },
  connected: { status: "running", label: "connected" },
  closed: { status: "stopped", label: "disconnected" },
};

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export interface SshTerminalProps {
  serverId: string;
  /** Server display name — chrome title + aria label. */
  serverName: string;
  sshUser: string;
}

export function SshTerminal({ serverId, serverName, sshUser }: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [elapsed, setElapsed] = useState("00:00");

  const socket = useTerminalSocket({
    serverId,
    onOutput: (data) => termRef.current?.write(data),
    onServerError: (message) => {
      termRef.current?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    },
  });

  // Stable refs so the mount effect never re-runs on socket state changes.
  const socketRef = useRef(socket);
  socketRef.current = socket;

  // Create xterm once, connect, and refit on container resize (debounced).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: 1.2,
      theme: TERMINAL_THEME,
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data) => socketRef.current.sendInput(data));

    socketRef.current.connect(term.cols, term.rows);

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const f = fitRef.current;
        const t = termRef.current;
        if (!f || !t) return;
        f.fit();
        socketRef.current.sendResize(t.cols, t.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    term.focus();

    return () => {
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      dataSub.dispose();
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
      // The socket itself is closed by the hook's own unmount cleanup.
    };
  }, [serverId]);

  // Session duration ticker (mm:ss) while connected; freezes when closed.
  useEffect(() => {
    if (socket.status !== "connected" || socket.connectedAt === null) return;
    const startedAt = socket.connectedAt;
    setElapsed(formatDuration(Date.now() - startedAt));
    const timer = setInterval(() => {
      setElapsed(formatDuration(Date.now() - startedAt));
    }, 1000);
    return () => clearInterval(timer);
  }, [socket.status, socket.connectedAt]);

  function reconnect() {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    setElapsed("00:00");
    socket.connect(term.cols, term.rows);
    term.focus();
  }

  const badge = STATUS_BADGE[socket.status];

  return (
    <div role="region" aria-label={`SSH terminal for ${serverName}`}>
      <div className="overflow-hidden rounded-[16px] border border-neutral-700 bg-terminal-bg">
        <div className="flex items-center gap-3 border-b border-white/[0.07] bg-neutral-800 px-3.5 py-[9px]">
          <div aria-hidden className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-600" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-600" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-600" />
          </div>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">
            {sshUser}@{serverName} — ssh session
          </span>
          <StatusBadge status={badge.status} label={badge.label} />
          <span className="font-mono text-xs tabular-nums text-neutral-400">
            {elapsed}
          </span>
          {socket.status !== "closed" ? (
            <Button variant="onDark" size="sm" onClick={socket.disconnect}>
              Disconnect
            </Button>
          ) : null}
        </div>

        <div
          className="relative h-[65vh] min-h-[320px]"
          onClick={() => termRef.current?.focus()}
        >
          <div ref={containerRef} className="h-full w-full px-3 py-2" />
          {socket.status === "closed" ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-terminal-bg/85 px-6 text-center">
              <p className="max-w-md font-mono text-[13px] text-neutral-300">
                {socket.closeReason ?? "Session closed."}
              </p>
              <Button onClick={reconnect}>Reconnect</Button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Screen-reader announcements for connect / disconnect (design §7). */}
      <div aria-live="polite" className="sr-only">
        {socket.status === "connected"
          ? `Terminal connected to ${serverName}.`
          : socket.status === "closed"
            ? `Terminal disconnected from ${serverName}. ${socket.closeReason ?? ""}`
            : `Connecting terminal to ${serverName}…`}
      </div>

      <p className="mt-2.5 text-xs text-neutral-400">
        Session metadata is audited (user, server, duration). Keystrokes are
        not recorded.
      </p>
    </div>
  );
}
