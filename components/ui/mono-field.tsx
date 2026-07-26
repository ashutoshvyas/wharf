"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { useToastOptional } from "@/components/ui/toast";

const MASK = "••••••••••••••••••••";
const REMASK_MS = 30_000;

export interface MonoFieldProps {
  /** Tracked label rendered above the field. */
  label?: string;
  /**
   * The value to display. For secret fields with `onReveal`, this may be
   * omitted — the value is fetched on first reveal.
   */
  value?: string;
  /** Mask the value until the eye toggle is pressed. Auto re-masks after 30s. */
  secret?: boolean;
  /**
   * Async reveal callback (the caller fetches its audited reveal endpoint).
   * When set, the component shows a spinner while fetching, then the value.
   */
  onReveal?: () => Promise<string>;
  className?: string;
}

export function MonoField({
  label,
  value,
  secret = false,
  onReveal,
  className,
}: MonoFieldProps) {
  const toastCtx = useToastOptional();
  const [revealed, setRevealed] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const remaskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (remaskTimer.current) clearTimeout(remaskTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const hide = useCallback(() => {
    setRevealed(false);
    if (remaskTimer.current) {
      clearTimeout(remaskTimer.current);
      remaskTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    setRevealed(true);
    if (remaskTimer.current) clearTimeout(remaskTimer.current);
    remaskTimer.current = setTimeout(() => setRevealed(false), REMASK_MS);
  }, []);

  /** Resolve the underlying value, fetching via onReveal when needed. */
  const resolveValue = useCallback(async (): Promise<string> => {
    if (fetched !== null) return fetched;
    if (onReveal) {
      const v = await onReveal();
      setFetched(v);
      return v;
    }
    return value ?? "";
  }, [fetched, onReveal, value]);

  const toggleReveal = useCallback(async () => {
    if (revealed) {
      hide();
      return;
    }
    if (secret && onReveal && fetched === null) {
      setLoading(true);
      try {
        await resolveValue();
        show();
      } catch {
        toastCtx?.toast({
          message: "Could not reveal this value.",
          variant: "danger",
          title: "Reveal failed",
        });
      } finally {
        setLoading(false);
      }
      return;
    }
    show();
  }, [revealed, secret, onReveal, fetched, hide, show, resolveValue, toastCtx]);

  const copy = useCallback(async () => {
    let text: string;
    try {
      text = await resolveValue();
    } catch {
      toastCtx?.toast({
        message: "Could not fetch the value to copy.",
        variant: "danger",
        title: "Copy failed",
      });
      return;
    }
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("no clipboard API");
      }
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    toastCtx?.toast({ message: "Copied to clipboard", variant: "success" });
  }, [resolveValue, toastCtx]);

  const displayed = secret && !revealed ? MASK : (fetched ?? value ?? "");

  return (
    <div className={className}>
      {label ? (
        <div className="label-track mb-[5px] text-neutral-500">{label}</div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 rounded-[6px] border border-neutral-200 bg-neutral-50 px-2.5 py-[7px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-neutral-700">
          {displayed}
        </span>
        {secret ? (
          <button
            type="button"
            aria-label={revealed ? "Hide value" : "Reveal value"}
            title={revealed ? "Hide" : "Reveal"}
            disabled={loading}
            onClick={() => void toggleReveal()}
            className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 disabled:pointer-events-none"
          >
            {loading ? (
              <LoaderCircle size={14} strokeWidth={1.75} className="animate-spin" />
            ) : revealed ? (
              <EyeOff size={14} strokeWidth={1.75} />
            ) : (
              <Eye size={14} strokeWidth={1.75} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Copy to clipboard"
          title="Copy"
          onClick={() => void copy()}
          className={cn(
            "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400",
            copied
              ? "text-success"
              : "text-neutral-400 hover:bg-cobalt-50 hover:text-cobalt-600",
          )}
        >
          {copied ? (
            <Check size={14} strokeWidth={2} />
          ) : (
            <Copy size={14} strokeWidth={1.75} />
          )}
        </button>
      </div>
    </div>
  );
}
