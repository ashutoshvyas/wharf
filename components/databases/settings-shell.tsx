"use client";

/**
 * Shared layout shell for WHARF-native settings pages embedded in Manage
 * (Auth settings, Email templates) — a left nav flush against a content
 * pane, both filling the available height, matching cloud-hosted Studio's
 * own settings-page chrome (left nav attached to content, independent
 * scroll regions) instead of a centered, margined stack of cards.
 *
 * The parent tab-content wrapper (manage-view.tsx) must NOT itself scroll
 * (`overflow-hidden`, not `overflow-y-auto`) — this shell owns scrolling
 * internally so the nav stays fixed while only the content pane scrolls,
 * same as Studio's own sub-nav.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function SettingsShell({
  nav,
  children,
  footer,
}: {
  nav: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full">
      <nav className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-neutral-200 bg-white p-3">
        {nav}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[680px] p-6">{children}</div>
        </div>
        {footer ? (
          <div className="flex shrink-0 justify-end border-t border-neutral-200 bg-white px-6 py-3.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsNavItem({
  active,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  icon?: ReactNode;
  label: string;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-[6px] px-3 py-2 text-left text-[13px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 focus-visible:ring-inset",
        active ? "bg-cobalt-50 text-cobalt-700" : "text-neutral-600 hover:bg-neutral-50",
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="flex-1 truncate">{label}</span>
      {badge}
    </button>
  );
}

export function SettingsHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-5">
      <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-1 text-[13px] text-neutral-500">{description}</p> : null}
    </div>
  );
}
