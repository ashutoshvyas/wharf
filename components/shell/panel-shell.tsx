"use client";

/**
 * App shell — persistent sidebar + topbar per design §3.
 * Role-gated nav: forbidden items are HIDDEN, not disabled (design §6).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Server,
  Globe,
  Database,
  ScrollText,
  Users,
  LogOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const MAIN_NAV: NavItem[] = [
  { href: "/servers", label: "Servers", icon: Server },
  { href: "/websites", label: "Websites", icon: Globe },
  { href: "/databases", label: "Databases", icon: Database },
];

const PAGE_TITLES: Array<[prefix: string, title: string]> = [
  ["/servers", "Servers"],
  ["/websites", "Websites"],
  ["/databases", "Databases"],
  ["/audit", "Audit log"],
  ["/users", "Users"],
];

function QubeMark() {
  return (
    <div className="grid h-[22px] w-[22px] grid-cols-2 gap-[2px]" aria-hidden>
      <span className="rounded-[2px] bg-cobalt-500" />
      <span className="rounded-[2px] bg-coral-500" />
      <span className="rounded-[2px] bg-cobalt-500" />
      <span className="rounded-[2px] bg-cobalt-500" />
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-sm font-medium transition-colors",
        active
          ? "bg-cobalt-50 text-cobalt-700 before:absolute before:-left-3 before:top-2 before:bottom-2 before:w-[3px] before:rounded-r-[2px] before:bg-coral-500 before:content-['']"
          : "text-neutral-600 hover:bg-neutral-50 hover:text-ink",
      )}
    >
      <Icon size={17} strokeWidth={1.75} aria-hidden />
      {item.label}
    </Link>
  );
}

export function PanelShell({
  user,
  signOutAction,
  children,
}: {
  user: { email: string; role: Role };
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const title =
    PAGE_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "WHARF";
  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <div className="flex min-h-screen bg-neutral-50 text-ink">
      {/* Sidebar */}
      <aside className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col border-r border-neutral-200 bg-white max-lg:w-[64px]">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5 max-lg:justify-center max-lg:px-2">
          <QubeMark />
          <span className="text-[19px] font-extrabold tracking-tight max-lg:hidden">
            wharf
          </span>
        </div>
        <nav
          className="flex flex-col gap-0.5 px-3 max-lg:px-2"
          aria-label="Main navigation"
        >
          {MAIN_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} />
          ))}
          <div className="mx-2 my-2.5 h-px bg-neutral-200" />
          <NavLink
            item={{ href: "/audit", label: "Audit log", icon: ScrollText }}
            active={isActive("/audit")}
          />
          {can(user.role, "users") && (
            <NavLink
              item={{ href: "/users", label: "Users", icon: Users }}
              active={isActive("/users")}
            />
          )}
        </nav>
        <div className="mt-auto px-5 py-4 font-mono text-[10px] tracking-[0.1em] text-neutral-400 max-lg:hidden">
          WHARF · CONTROL PLANE
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-6">
          <h1 className="text-lg font-bold tracking-tight">{title}</h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2.5 rounded-full border border-neutral-200 py-1 pl-1.5 pr-3">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full bg-cobalt-500 text-[11px] font-bold text-white"
                aria-hidden
              >
                {user.email[0]?.toUpperCase()}
              </span>
              <span className="text-[13.5px] font-semibold max-md:hidden">
                {user.email.split("@")[0]}
              </span>
              <Badge
                variant={user.role === "admin" ? "cobalt" : "neutral"}
                className="font-mono text-[10px] uppercase tracking-[0.1em]"
              >
                {user.role}
              </Badge>
            </div>
            <form action={signOutAction}>
              <button
                type="submit"
                title="Sign out"
                className="flex h-8 w-8 items-center justify-center rounded-sm text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
              >
                <LogOut size={16} strokeWidth={1.75} aria-hidden />
                <span className="sr-only">Sign out</span>
              </button>
            </form>
          </div>
        </header>
        <main className="w-full max-w-[1400px] flex-1 p-6 xl:px-8 xl:py-7">
          {children}
        </main>
      </div>
    </div>
  );
}
