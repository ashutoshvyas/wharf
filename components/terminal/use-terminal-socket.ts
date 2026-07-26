"use client";

/**
 * WebSocket client for the Terminal Gateway — implements the wire
 * protocol in docs/terminal-protocol.md exactly:
 *
 * - Binary frames both ways: raw terminal bytes (stdin →, stdout/stderr ←).
 * - Text frames: single JSON object discriminated by `t`:
 *     client→server {"t":"resize",cols,rows} | {"t":"ping"}
 *     server→client {"t":"pong"} | {"t":"ready"} | {"t":"error",message}
 *                   | {"t":"exit",code}
 * - Close codes 4001/4002/4003/4008/4009 map to human-readable text.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type TerminalStatus = "connecting" | "connected" | "closed";

const PING_INTERVAL_MS = 25_000;

const GATEWAY_BASE = (
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:3001"
).replace(/\/$/, "");

function gatewayUrl(serverId: string, cols: number, rows: number): string {
  return `${GATEWAY_BASE}/ws/terminal/${serverId}?cols=${cols}&rows=${rows}`;
}

/** Protocol close-code table → human text (docs/terminal-protocol.md). */
function closeMessage(
  code: number,
  lastError: string | null,
  exitCode: number | null,
): string {
  switch (code) {
    case 1000:
      return exitCode !== null
        ? `Remote shell exited (code ${exitCode}).`
        : "Session closed.";
    case 4001:
      return "Authentication failed — sign in again and retry.";
    case 4002:
      return "Unknown server — it may have been deleted.";
    case 4003:
      return lastError ?? "SSH connection error.";
    case 4008:
      return "Session timed out (30 min idle / 8 h absolute cap).";
    case 4009:
      return "Concurrent session limit reached (3 per user). Close another session first.";
    // 1006 = closed abnormally with no close frame, i.e. the socket never
    // established. In practice this is almost always the gateway not running
    // (it is a SEPARATE process from the panel) — so say that instead of
    // showing a raw code the operator has to look up.
    case 1006:
      return (
        lastError ??
        `Could not reach the terminal gateway at ${GATEWAY_BASE}. ` +
          "It runs as a separate service from the panel — check that it is " +
          "started and that the URL is correct."
      );
    default:
      return lastError ?? `Connection closed (code ${code}).`;
  }
}

export interface UseTerminalSocketOptions {
  serverId: string;
  /** Raw bytes from the remote shell — write straight into xterm. */
  onOutput: (data: Uint8Array) => void;
  /** Server-sent {"t":"error"} frame (arrives before an abnormal close). */
  onServerError?: (message: string) => void;
}

export interface TerminalSocket {
  status: TerminalStatus;
  /** Human-readable reason once status === "closed". */
  closeReason: string | null;
  /** Epoch ms of the "ready" frame (session start), null until connected. */
  connectedAt: number | null;
  /** Open a fresh socket (closes any existing one first). */
  connect: (cols: number, rows: number) => void;
  /** Client-initiated disconnect (close 1000). */
  disconnect: () => void;
  /** stdin → binary frame. */
  sendInput: (data: string) => void;
  /** PTY resize → {"t":"resize",cols,rows}. */
  sendResize: (cols: number, rows: number) => void;
}

export function useTerminalSocket({
  serverId,
  onOutput,
  onServerError,
}: UseTerminalSocketOptions): TerminalSocket {
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastError = useRef<string | null>(null);
  const exitCode = useRef<number | null>(null);
  const encoder = useRef(new TextEncoder());
  // Keep callbacks fresh without re-creating the socket.
  const onOutputRef = useRef(onOutput);
  const onServerErrorRef = useRef(onServerError);
  onOutputRef.current = onOutput;
  onServerErrorRef.current = onServerError;

  const clearPing = useCallback(() => {
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
  }, []);

  const teardown = useCallback(
    (code?: number) => {
      clearPing();
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        // Detach handlers so a stale socket can't clobber a fresh session.
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close(code ?? 1000);
        } catch {
          // already closing
        }
      }
    },
    [clearPing],
  );

  const connect = useCallback(
    (cols: number, rows: number) => {
      teardown();
      lastError.current = null;
      exitCode.current = null;
      setCloseReason(null);
      setConnectedAt(null);
      setStatus("connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(gatewayUrl(serverId, cols, rows));
      } catch {
        setStatus("closed");
        setCloseReason("Could not reach the terminal gateway.");
        return;
      }
      ws.binaryType = "arraybuffer";
      socketRef.current = ws;

      ws.onopen = () => {
        clearPing();
        pingTimer.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "ping" }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (ev.data instanceof ArrayBuffer) {
          onOutputRef.current(new Uint8Array(ev.data));
          return;
        }
        if (typeof ev.data !== "string") return;
        let frame: { t?: string; message?: string; code?: number | null };
        try {
          frame = JSON.parse(ev.data) as typeof frame;
        } catch {
          return; // not a protocol frame — ignore
        }
        switch (frame.t) {
          case "ready":
            setStatus("connected");
            setConnectedAt(Date.now());
            break;
          case "pong":
            break; // keepalive reply
          case "error":
            lastError.current = frame.message ?? "SSH error";
            onServerErrorRef.current?.(lastError.current);
            break;
          case "exit":
            exitCode.current = typeof frame.code === "number" ? frame.code : null;
            break;
        }
      };

      ws.onclose = (ev: CloseEvent) => {
        if (socketRef.current === ws) socketRef.current = null;
        clearPing();
        setStatus("closed");
        setCloseReason(closeMessage(ev.code, lastError.current, exitCode.current));
      };

      ws.onerror = () => {
        // onclose always follows; nothing to surface here beyond the close map.
      };
    },
    [serverId, teardown, clearPing],
  );

  const disconnect = useCallback(() => {
    teardown(1000);
    setStatus("closed");
    setCloseReason("Disconnected.");
  }, [teardown]);

  const sendInput = useCallback((data: string) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encoder.current.encode(data));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "resize", cols, rows }));
    }
  }, []);

  // Unmount cleanup: close the socket + clear the keepalive timer.
  useEffect(() => () => teardown(1000), [teardown]);

  return {
    status,
    closeReason,
    connectedAt,
    connect,
    disconnect,
    sendInput,
    sendResize,
  };
}
