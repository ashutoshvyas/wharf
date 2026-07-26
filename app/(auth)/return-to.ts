import { isTrustedInstanceHost } from "@/lib/instance-host";

/**
 * Prevent open redirects: same-origin relative paths pass through as-is.
 * An absolute URL only passes through when its host is a WHARF-managed
 * instance subdomain — that's the shape the Studio forwardAuth gate sends
 * (studio-{slug}.INSTANCE_DOMAIN is a different origin than the panel, so a
 * relative path can't express it). Anything else — including any other
 * absolute URL — falls back to the panel's own dashboard.
 *
 * Lives outside actions.ts because that file is a "use server" module, where
 * Next.js requires every export to be an async function.
 */
export function safeReturnTo(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) {
    return value;
  }
  try {
    const url = new URL(value);
    if (isTrustedInstanceHost(url.hostname)) return url.toString();
  } catch {
    // not a valid absolute URL either
  }
  return "/databases";
}
