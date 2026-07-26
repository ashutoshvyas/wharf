/**
 * Boot-time configuration validation.
 *
 * These are settings whose misconfiguration produces confusing *runtime*
 * symptoms rather than crashes — the Studio SSO chain in particular fails as
 * "Studio keeps redirecting me to login", with nothing in any log to explain
 * it. Catch them once at boot and say exactly what is wrong.
 *
 * Warnings only: the panel still starts. Websites/Servers/terminal all work
 * without any of this; only database provisioning and Studio SSO need it.
 */

export interface ConfigProblem {
  setting: string;
  message: string;
}

/** Strip a leading dot so ".wharf.example.com" and "wharf.example.com" compare equal. */
function bareDomain(value: string): string {
  return value.trim().replace(/^\./, "").toLowerCase();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `sub.example.com` is under `example.com`; `example.com` is under itself. */
function isUnder(host: string, apex: string): boolean {
  return host === apex || host.endsWith(`.${apex}`);
}

export function checkConfig(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  const panelUrl = env.PANEL_URL?.trim() ?? "";
  const cookieDomain = env.COOKIE_DOMAIN?.trim() ?? "";
  const instanceDomain = env.INSTANCE_DOMAIN?.trim() ?? "";
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(panelUrl);

  if (!instanceDomain) {
    problems.push({
      setting: "INSTANCE_DOMAIN",
      message:
        "not set — provisioning will refuse to start. Set it to the apex domain " +
        "whose wildcard DNS record points at your database server.",
    });
  }

  // The forwardAuth chain (architecture §4.5): the browser only sends the
  // panel session cookie to studio-*.INSTANCE_DOMAIN if the cookie is scoped
  // to a domain that covers both hosts.
  if (isLocal) {
    if (cookieDomain) {
      problems.push({
        setting: "COOKIE_DOMAIN",
        message:
          `set to "${cookieDomain}" while PANEL_URL is localhost — browsers reject ` +
          "domain-scoped cookies for localhost. Leave it empty in development.",
      });
    }
    // Local dev: Studio SSO cannot work regardless; not worth warning about.
    return problems;
  }

  if (!cookieDomain) {
    problems.push({
      setting: "COOKIE_DOMAIN",
      message:
        "not set — the session cookie will be host-only, so Traefik's forwardAuth " +
        "on studio-*.<domain> will never see it and every Studio request will be " +
        `denied. Set it to ".${instanceDomain || "<your-apex-domain>"}".`,
    });
  } else if (instanceDomain) {
    const apex = bareDomain(cookieDomain);
    if (!isUnder(bareDomain(instanceDomain), apex)) {
      problems.push({
        setting: "COOKIE_DOMAIN",
        message:
          `"${cookieDomain}" does not cover INSTANCE_DOMAIN "${instanceDomain}" — ` +
          "instance subdomains will not receive the session cookie and Studio SSO " +
          "will fail. Both must share an apex.",
      });
    }
  }

  const panelHost = panelUrl ? hostOf(panelUrl) : null;
  if (panelHost && cookieDomain && !isUnder(panelHost, bareDomain(cookieDomain))) {
    problems.push({
      setting: "PANEL_URL",
      message:
        `panel host "${panelHost}" is not under COOKIE_DOMAIN "${cookieDomain}" — ` +
        "the panel will not receive its own session cookie.",
    });
  }

  if (panelUrl && !panelUrl.startsWith("https://")) {
    problems.push({
      setting: "PANEL_URL",
      message:
        "is not https — Traefik calls this URL for forwardAuth and browsers will " +
        "refuse to send a Secure session cookie over plain http.",
    });
  }

  return problems;
}

/** Log any problems as a single, prominent block. Never throws. */
export function reportConfigProblems(problems: ConfigProblem[]): void {
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  - ${p.setting}: ${p.message}`);
  console.warn(
    "[wharf] configuration problems detected (the panel will start, but " +
      "database provisioning and/or Studio SSO will not work):\n" +
      lines.join("\n") +
      "\n  See docs/deployment.md — 'Domains and the Studio SSO chain'.",
  );
}
