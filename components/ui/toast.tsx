"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastVariant = "info" | "success" | "warning" | "danger";

export interface ToastOptions {
  title?: string;
  message: string;
  variant?: ToastVariant;
}

interface ToastItem extends ToastOptions {
  id: number;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Strict hook — throws when no <ToastProvider> is mounted. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

/** Lenient hook for components that should degrade gracefully without a provider. */
export function useToastOptional(): ToastContextValue | null {
  return useContext(ToastContext);
}

const BORDER: Record<ToastVariant, string> = {
  info: "border-l-cobalt-500",
  success: "border-l-success",
  warning: "border-l-warning",
  danger: "border-l-danger",
};

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const item: ToastItem = {
        id,
        variant: options.variant ?? "info",
        title: options.title,
        message: options.message,
      };
      setToasts((prev) => [...prev, item]);
      // Danger toasts require manual dismissal; everything else auto-dismisses.
      if (item.variant !== "danger") {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
        );
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="fixed right-5 bottom-5 z-[200] flex flex-col gap-2.5"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "flex min-w-[280px] max-w-[380px] items-start gap-2.5 rounded-[12px] border border-neutral-200 border-l-[3px] bg-white px-4 py-3 text-[13.5px] text-ink shadow-md",
              BORDER[t.variant],
            )}
          >
            <div className="min-w-0">
              {t.title ? <b className="block font-semibold">{t.title}</b> : null}
              {t.message}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="ml-auto inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
