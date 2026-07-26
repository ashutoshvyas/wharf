"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** max-w-[640px] instead of the default 520px. */
  wide?: boolean;
  /** Accessible name for the dialog (use when there is no ModalHead title). */
  ariaLabel?: string;
  className?: string;
}

/**
 * Hand-rolled modal primitive: portal, cobalt-tinted blurred overlay,
 * focus trap, Escape / overlay-click close, aria-modal.
 */
export function Dialog({
  open,
  onClose,
  children,
  wide = false,
  ariaLabel,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !panelRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !panelRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.addEventListener("keydown", handleKeyDown, true);
    // Move focus into the dialog.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      cancelAnimationFrame(raf);
      previouslyFocused.current?.focus?.();
    };
  }, [open, handleKeyDown]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-[rgba(21,44,107,0.35)] p-5 pt-[6vh] backdrop-blur-[2px]"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          "w-full rounded-[16px] bg-white shadow-lg outline-none",
          wide ? "max-w-[640px]" : "max-w-[520px]",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface ModalHeadProps {
  title: ReactNode;
  onClose: () => void;
}

export function ModalHead({ title, onClose }: ModalHeadProps) {
  return (
    <div className="flex items-center justify-between px-[22px] pt-[18px]">
      <h3 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h3>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

export function ModalBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-[22px] pt-4 pb-[22px] text-sm", className)}>
      {children}
    </div>
  );
}

export function ModalFoot({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex justify-end gap-2.5 px-[22px] pb-5", className)}>
      {children}
    </div>
  );
}
