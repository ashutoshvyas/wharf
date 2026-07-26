"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export type DropdownItem =
  | {
      type?: "item";
      label: ReactNode;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: "separator" };

export interface DropdownMenuProps {
  /** The trigger element (e.g. an icon button); clicking it toggles the menu. */
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "start" | "end";
  className?: string;
}

export function DropdownMenu({
  trigger,
  items,
  align = "start",
  className,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position after the menu renders so we know its size.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const r = anchor.getBoundingClientRect();
    const top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 10);
    const left = Math.max(
      10,
      Math.min(
        align === "end" ? r.right - menu.offsetWidth : r.left,
        window.innerWidth - menu.offsetWidth - 10,
      ),
    );
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </span>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className={cn(
                "fixed z-[120] min-w-[190px] rounded-[12px] border border-neutral-200 bg-white p-1.5 shadow-md",
                className,
              )}
            >
              {items.map((item, i) =>
                item.type === "separator" ? (
                  <div key={i} className="mx-1 my-[5px] h-px bg-neutral-100" />
                ) : (
                  <button
                    key={i}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-[6px] px-3 py-2 text-left text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt-400 disabled:pointer-events-none disabled:opacity-50",
                      item.danger
                        ? "text-danger hover:bg-[rgba(216,73,60,0.07)]"
                        : "text-neutral-700 hover:bg-neutral-50",
                    )}
                  >
                    {item.icon ? (
                      <span className="shrink-0">{item.icon}</span>
                    ) : null}
                    {item.label}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
