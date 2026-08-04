"use client";

/**
 * Auth settings form — the self-hosted-configurable subset of
 * GoTrue's Auth config (OAuth providers, SMTP, sign-up/session toggles).
 *
 * Built because self-hosted Supabase Studio's own Authentication →
 * Configuration pages (Providers, Sessions, Rate Limits, etc.) are gated
 * behind Supabase Cloud's platform-only management API and never render —
 * confirmed against a live upstream Studio issue. This is native WHARF UI,
 * not a Studio patch: it re-renders the instance's docker-compose.yml/.env
 * and restarts only its `auth` container to apply a change
 * (lib/provision/auth-settings.ts).
 *
 * Secret fields (OAuth client secrets, SMTP password) always render blank
 * with a "(unchanged)" placeholder — same convention as
 * server-form-modal.tsx's edit mode. Viewing is available to anyone who can
 * reach this page (operator+, matching secrets.reveal — the page itself
 * already gates on that); only admin can submit changes.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleCheck, KeyRound, Mail, Phone, ShieldCheck } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MonoField } from "@/components/ui/mono-field";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { SettingsHeading, SettingsNavItem, SettingsShell } from "./settings-shell";
import {
  fetchAuthSettings,
  updateAuthSettings,
  type AuthSettingsDto,
  type AuthSettingsUpdatePayload,
  type InstanceDto,
  type SmsProviderDto,
} from "./api";

type SettingsSection = "session" | "smtp" | "providers";

const SECTIONS: { key: SettingsSection; label: string; icon: ReactNode }[] = [
  { key: "session", label: "Session", icon: <ShieldCheck size={16} strokeWidth={1.75} /> },
  { key: "smtp", label: "SMTP", icon: <Mail size={16} strokeWidth={1.75} /> },
  { key: "providers", label: "Providers", icon: <KeyRound size={16} strokeWidth={1.75} /> },
];

const INPUT_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none " +
  "disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label-track mb-1.5 block text-neutral-500">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2.5 text-[13px] text-ink">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded-[3px] border-neutral-300 text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 disabled:cursor-not-allowed"
      />
      {label}
    </label>
  );
}

/** Minimal 4-color Google "G" mark — identification only, no trademark asset used. */
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.47a5.54 5.54 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.92l-3.88-3c-1.08.72-2.46 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54v-3.1H1.27a12 12 0 0 0 0 10.74l4-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.63l4 3.1c.95-2.85 3.6-4.96 6.73-4.96Z"
      />
    </svg>
  );
}

/** Minimal 4-square Microsoft/Azure mark — identification only, no trademark asset used. */
function AzureIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
      <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

/** Apple's mark, drawn inline for the same reason as the others — identification only. */
function AppleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.05 12.54c-.03-2.7 2.2-4 2.3-4.06-1.25-1.83-3.2-2.08-3.9-2.11-1.66-.17-3.24.98-4.08.98-.84 0-2.14-.96-3.52-.93-1.81.03-3.48 1.05-4.41 2.67-1.88 3.26-.48 8.08 1.35 10.72.9 1.29 1.96 2.74 3.36 2.69 1.35-.06 1.86-.87 3.49-.87 1.63 0 2.09.87 3.51.84 1.45-.03 2.37-1.32 3.26-2.61 1.03-1.5 1.45-2.95 1.47-3.02-.03-.01-2.82-1.08-2.85-4.3M14.4 4.6c.74-.9 1.24-2.15 1.1-3.4-1.07.05-2.36.71-3.13 1.61-.69.8-1.29 2.07-1.13 3.29 1.19.1 2.41-.6 3.16-1.5" />
    </svg>
  );
}

/** GitHub's "octocat" mark — lucide-react ships no brand icons, so drawn inline. */
function GithubIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.02c-3.34.72-4.04-1.61-4.04-1.61-.55-1.38-1.34-1.75-1.34-1.75-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.93.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .3Z" />
    </svg>
  );
}

/**
 * Accordion row matching self-hosted Studio's cloud-hosted counterpart's
 * "Auth Providers" list — icon, name, Enabled/Disabled pill, click to expand
 * inline config. Only relevant for providers this row actually has
 * configurable detail for; `children` omitted (e.g. Phone, with no
 * self-hosted SMS provider wired up yet) renders no expand affordance.
 */
function ProviderRow({
  icon,
  name,
  enabled,
  expanded,
  onToggleExpand,
  children,
}: {
  icon: ReactNode;
  name: string;
  enabled: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-neutral-100 last:border-0">
      <button
        type="button"
        onClick={onToggleExpand}
        disabled={!children}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 focus-visible:ring-inset disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-neutral-500">
          {icon}
        </span>
        <span className="flex-1 text-[13.5px] font-medium text-ink">{name}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium",
            enabled
              ? "bg-[rgba(46,158,107,0.12)] text-[#1d6b46]"
              : "border border-neutral-200 text-neutral-500",
          )}
        >
          {enabled ? <CircleCheck size={12} strokeWidth={2} /> : null}
          {enabled ? "Enabled" : "Disabled"}
        </span>
        {children ? (
          <ChevronRight
            size={15}
            strokeWidth={1.75}
            className={cn(
              "shrink-0 text-neutral-400 transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : (
          <span className="w-[15px]" />
        )}
      </button>
      {expanded && children ? (
        <div className="flex flex-col gap-3.5 border-t border-neutral-100 bg-neutral-50/60 px-4 py-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Form state — secret fields always start blank regardless of `*Configured`. */
interface FormState {
  disableSignup: boolean;
  enableEmailSignup: boolean;
  enableEmailAutoconfirm: boolean;
  enablePhoneSignup: boolean;
  enablePhoneAutoconfirm: boolean;
  enableAnonymousUsers: boolean;
  manualLinkingEnabled: boolean;
  jwtExpirySeconds: string;
  additionalRedirectUrls: string;
  siteUrl: string;
  oauthCallbackUrl: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  smtpSenderName: string;
  smtpAdminEmail: string;
  smsProvider: SmsProviderDto;
  smsOtpExp: string;
  smsOtpLength: string;
  smsMaxFrequency: string;
  smsTemplate: string;
  smsTwilioAccountSid: string;
  smsTwilioAuthToken: string;
  smsTwilioMessageServiceSid: string;
  smsMsg91AuthKey: string;
  smsMsg91TemplateId: string;
  smsMsg91SenderId: string;
  smsMsg91OtpVariable: string;
  googleEnabled: boolean;
  googleClientId: string;
  googleSecret: string;
  googleSkipNonceCheck: boolean;
  googleEmailOptional: boolean;
  githubEnabled: boolean;
  githubClientId: string;
  githubSecret: string;
  azureEnabled: boolean;
  azureClientId: string;
  azureSecret: string;
  appleEnabled: boolean;
  appleClientId: string;
  appleSecret: string;
  appleEmailOptional: boolean;
}

function formFromDto(dto: AuthSettingsDto): FormState {
  return {
    disableSignup: dto.disableSignup,
    enableEmailSignup: dto.enableEmailSignup,
    enableEmailAutoconfirm: dto.enableEmailAutoconfirm,
    enablePhoneSignup: dto.enablePhoneSignup,
    enablePhoneAutoconfirm: dto.enablePhoneAutoconfirm,
    enableAnonymousUsers: dto.enableAnonymousUsers,
    manualLinkingEnabled: dto.manualLinkingEnabled,
    jwtExpirySeconds: String(dto.jwtExpirySeconds),
    additionalRedirectUrls: dto.additionalRedirectUrls,
    siteUrl: dto.siteUrl,
    oauthCallbackUrl: dto.oauthCallbackUrl,
    smtpHost: dto.smtpHost,
    smtpPort: String(dto.smtpPort),
    smtpUser: dto.smtpUser,
    smtpPass: "",
    smtpSenderName: dto.smtpSenderName,
    smtpAdminEmail: dto.smtpAdminEmail,
    smsProvider: dto.smsProvider,
    smsOtpExp: String(dto.smsOtpExp),
    smsOtpLength: String(dto.smsOtpLength),
    smsMaxFrequency: dto.smsMaxFrequency,
    smsTemplate: dto.smsTemplate,
    smsTwilioAccountSid: dto.smsTwilioAccountSid,
    smsTwilioAuthToken: "",
    smsTwilioMessageServiceSid: dto.smsTwilioMessageServiceSid,
    smsMsg91AuthKey: "",
    smsMsg91TemplateId: dto.smsMsg91TemplateId,
    smsMsg91SenderId: dto.smsMsg91SenderId,
    smsMsg91OtpVariable: dto.smsMsg91OtpVariable,
    googleEnabled: dto.googleEnabled,
    googleClientId: dto.googleClientId,
    googleSecret: "",
    googleSkipNonceCheck: dto.googleSkipNonceCheck,
    googleEmailOptional: dto.googleEmailOptional,
    githubEnabled: dto.githubEnabled,
    githubClientId: dto.githubClientId,
    githubSecret: "",
    azureEnabled: dto.azureEnabled,
    azureClientId: dto.azureClientId,
    azureSecret: "",
    appleEnabled: dto.appleEnabled,
    appleClientId: dto.appleClientId,
    appleSecret: "",
    appleEmailOptional: dto.appleEmailOptional,
  };
}

function toPayload(form: FormState): AuthSettingsUpdatePayload {
  return {
    disableSignup: form.disableSignup,
    enableEmailSignup: form.enableEmailSignup,
    enableEmailAutoconfirm: form.enableEmailAutoconfirm,
    enablePhoneSignup: form.enablePhoneSignup,
    enablePhoneAutoconfirm: form.enablePhoneAutoconfirm,
    enableAnonymousUsers: form.enableAnonymousUsers,
    manualLinkingEnabled: form.manualLinkingEnabled,
    jwtExpirySeconds: Number(form.jwtExpirySeconds),
    additionalRedirectUrls: form.additionalRedirectUrls,
    // Trimmed, so a stray space can't turn "unset" into a URL GoTrue rejects.
    siteUrl: form.siteUrl.trim(),
    oauthCallbackUrl: form.oauthCallbackUrl.trim(),
    smtpHost: form.smtpHost,
    smtpPort: Number(form.smtpPort),
    smtpUser: form.smtpUser,
    ...(form.smtpPass ? { smtpPass: form.smtpPass } : {}),
    smtpSenderName: form.smtpSenderName,
    smtpAdminEmail: form.smtpAdminEmail,
    smsProvider: form.smsProvider,
    smsOtpExp: Number(form.smsOtpExp),
    smsOtpLength: Number(form.smsOtpLength),
    smsMaxFrequency: form.smsMaxFrequency.trim(),
    smsTemplate: form.smsTemplate,
    smsTwilioAccountSid: form.smsTwilioAccountSid.trim(),
    ...(form.smsTwilioAuthToken ? { smsTwilioAuthToken: form.smsTwilioAuthToken } : {}),
    smsTwilioMessageServiceSid: form.smsTwilioMessageServiceSid.trim(),
    ...(form.smsMsg91AuthKey ? { smsMsg91AuthKey: form.smsMsg91AuthKey } : {}),
    smsMsg91TemplateId: form.smsMsg91TemplateId.trim(),
    smsMsg91SenderId: form.smsMsg91SenderId.trim(),
    smsMsg91OtpVariable: form.smsMsg91OtpVariable.trim(),
    googleEnabled: form.googleEnabled,
    googleClientId: form.googleClientId,
    ...(form.googleSecret ? { googleSecret: form.googleSecret } : {}),
    googleSkipNonceCheck: form.googleSkipNonceCheck,
    googleEmailOptional: form.googleEmailOptional,
    githubEnabled: form.githubEnabled,
    githubClientId: form.githubClientId,
    ...(form.githubSecret ? { githubSecret: form.githubSecret } : {}),
    azureEnabled: form.azureEnabled,
    azureClientId: form.azureClientId,
    ...(form.azureSecret ? { azureSecret: form.azureSecret } : {}),
    appleEnabled: form.appleEnabled,
    appleClientId: form.appleClientId,
    ...(form.appleSecret ? { appleSecret: form.appleSecret } : {}),
    appleEmailOptional: form.appleEmailOptional,
  };
}

export function AuthSettingsForm({ instance, role }: { instance: InstanceDto; role: Role }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(role, "instance.auth-settings.write");
  const queryKey = ["auth-settings", instance.id];
  // What an empty Site URL / callback override falls back to. Mirrors
  // lib/provision/render.ts, which builds API_EXTERNAL_URL the same way and
  // resolves both fallbacks server-side — these are for display only.
  const defaultSiteUrl = `https://${instance.apiSubdomain}`;
  const defaultCallbackUrl = `${defaultSiteUrl}/auth/v1/callback`;

  const query = useQuery({
    queryKey,
    queryFn: () => fetchAuthSettings(instance.id),
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>("session");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const toggleExpanded = (name: string) =>
    setExpandedProvider((current) => (current === name ? null : name));

  useEffect(() => {
    if (query.data) setForm(formFromDto(query.data));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (payload: AuthSettingsUpdatePayload) => updateAuthSettings(instance.id, payload),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey });
      setForm(formFromDto(result));
      toast({
        title: result.applied ? "Saved" : "Saved, but the restart failed",
        message: result.applied
          ? `Auth settings updated — ${instance.name}'s auth container was restarted to apply them.`
          : `Settings were saved, but restarting the auth container failed: ${result.applyError ?? "unknown error"}. Retry from here once the server issue clears.`,
        variant: result.applied ? "success" : "danger",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", message: err.message, variant: "danger" });
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form || !canWrite || save.isPending) return;
    save.mutate(toPayload(form));
  }

  if (query.isPending || !form) {
    return (
      <div className="p-6">
        <Card className="p-5">
          <p className="text-[13px] text-neutral-500">Loading Auth settings…</p>
        </Card>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="p-6">
        <Alert variant="danger" title="Could not load Auth settings">
          <p>{query.error.message}</p>
        </Alert>
      </div>
    );
  }

  // What to actually paste into each provider's console: the override when
  // one is set, the derived default otherwise. Reads from form state rather
  // than the DTO so it tracks the override input live, before a save.
  const effectiveCallbackUrl = form.oauthCallbackUrl.trim() || defaultCallbackUrl;

  return (
    <form onSubmit={handleSubmit} className="h-full">
      <SettingsShell
        nav={SECTIONS.map((s) => (
          <SettingsNavItem
            key={s.key}
            icon={s.icon}
            label={s.label}
            active={activeSection === s.key}
            onClick={() => setActiveSection(s.key)}
          />
        ))}
        footer={
          canWrite ? (
            <Button type="submit" variant="accent" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save & restart auth"}
            </Button>
          ) : undefined
        }
      >
        {!canWrite ? (
          <Alert variant="info" className="mb-5">
            Viewing only — changing Auth settings requires the admin role.
          </Alert>
        ) : null}

        {activeSection === "session" ? (
          <div className="flex flex-col gap-3.5">
            <SettingsHeading
              title="Session"
              description="Mirrors GoTrue's own env-var-driven config — the same settings Studio's Configuration pages would show, if self-hosted Studio rendered them."
            />
            <Toggle
              label="Disable new sign-ups entirely"
              checked={form.disableSignup}
              disabled={!canWrite}
              onChange={(v) => setForm({ ...form, disableSignup: v })}
            />
            <div>
              <Toggle
                label="Allow manual linking"
                checked={form.manualLinkingEnabled}
                disabled={!canWrite}
                onChange={(v) => setForm({ ...form, manualLinkingEnabled: v })}
              />
              <p className="mt-1 text-xs text-neutral-500">
                Enables GoTrue&apos;s manual linking APIs, so a signed-in user can attach a
                second provider (or unlink one) from their existing account.
              </p>
            </div>
            <Toggle
              label="Allow anonymous sign-ins"
              checked={form.enableAnonymousUsers}
              disabled={!canWrite}
              onChange={(v) => setForm({ ...form, enableAnonymousUsers: v })}
            />
            <Field label="Session (JWT) expiry, in seconds">
              <input
                type="number"
                min={300}
                max={604_800}
                value={form.jwtExpirySeconds}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, jwtExpirySeconds: e.target.value })}
                className={INPUT_CLASSES}
              />
            </Field>
            <Field
              label="Site URL"
              hint="The web app this database backs. Where GoTrue sends a user after sign-in, password recovery and email confirmation, and the base for links in its emails. Leave blank to use this instance's own API origin."
            >
              <input
                type="url"
                value={form.siteUrl}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, siteUrl: e.target.value })}
                placeholder={defaultSiteUrl}
                className={INPUT_CLASSES}
              />
            </Field>
            <Field
              label="Additional redirect URLs"
              hint="Comma-separated. Extra URLs GoTrue will allow redirecting to after auth, beyond the Site URL above."
            >
              <input
                value={form.additionalRedirectUrls}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, additionalRedirectUrls: e.target.value })}
                placeholder="https://app.example.com/callback"
                className={INPUT_CLASSES}
              />
            </Field>
          </div>
        ) : null}

        {activeSection === "smtp" ? (
          <div className="flex flex-col gap-3.5">
            <SettingsHeading
              title="SMTP"
              description="Without a real relay configured, email sign-ups auto-confirm instead of sending a confirmation mail — set these and turn autoconfirm off (under Providers → Email) for a real sign-up flow."
            />
            <Field label="SMTP host">
              <input
                value={form.smtpHost}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
                className={INPUT_CLASSES}
              />
            </Field>
            <Field label="SMTP port">
              <input
                type="number"
                min={1}
                max={65_535}
                value={form.smtpPort}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, smtpPort: e.target.value })}
                className={INPUT_CLASSES}
              />
            </Field>
            <Field label="SMTP user">
              <input
                value={form.smtpUser}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, smtpUser: e.target.value })}
                className={INPUT_CLASSES}
              />
            </Field>
            <Field label="SMTP password">
              <input
                type="password"
                autoComplete="off"
                value={form.smtpPass}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, smtpPass: e.target.value })}
                placeholder={query.data.smtpPassConfigured ? "(unchanged)" : ""}
                className={INPUT_CLASSES}
              />
            </Field>
            <Field label="Sender name">
              <input
                value={form.smtpSenderName}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, smtpSenderName: e.target.value })}
                className={INPUT_CLASSES}
              />
            </Field>
            <Field label="Admin email">
              <input
                type="email"
                value={form.smtpAdminEmail}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, smtpAdminEmail: e.target.value })}
                className={INPUT_CLASSES}
              />
            </Field>
          </div>
        ) : null}

        {activeSection === "providers" ? (
          <div>
            <SettingsHeading
              title="Providers"
              description="Authenticate your users through a suite of providers and login methods."
            />
            <div className="mb-4">
              <Field
                label="OAuth callback URL override"
                hint="Shared by every provider below. Leave blank unless a custom domain fronts this instance and proxies /auth/v1/* through to it — this address must reach this instance's own auth container, not your web app. Use Site URL for where users land after signing in."
              >
                <input
                  type="url"
                  value={form.oauthCallbackUrl}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, oauthCallbackUrl: e.target.value })}
                  placeholder={defaultCallbackUrl}
                  className={INPUT_CLASSES}
                />
              </Field>
            </div>
            <div className="overflow-hidden rounded-[10px] border border-neutral-200 bg-white">
              <ProviderRow
                icon={<Mail size={17} strokeWidth={1.75} />}
                name="Email"
                enabled={form.enableEmailSignup}
                expanded={expandedProvider === "email"}
                onToggleExpand={() => toggleExpanded("email")}
              >
                <Toggle
                  label="Allow email sign-up"
                  checked={form.enableEmailSignup}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, enableEmailSignup: v })}
                />
                <Toggle
                  label="Auto-confirm email sign-ups (skip the confirmation email)"
                  checked={form.enableEmailAutoconfirm}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, enableEmailAutoconfirm: v })}
                />
              </ProviderRow>

              <ProviderRow
                icon={<Phone size={17} strokeWidth={1.75} />}
                name="Phone"
                enabled={form.enablePhoneSignup}
                expanded={expandedProvider === "phone"}
                onToggleExpand={() => toggleExpanded("phone")}
              >
                <Toggle
                  label="Allow phone sign-up"
                  checked={form.enablePhoneSignup}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, enablePhoneSignup: v })}
                />
                <div>
                  <Toggle
                    label="Auto-confirm phone sign-ups (skip the verification SMS)"
                    checked={form.enablePhoneAutoconfirm}
                    disabled={!canWrite}
                    onChange={(v) => setForm({ ...form, enablePhoneAutoconfirm: v })}
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    On, a phone number is marked confirmed at sign-up without any code being
                    sent or checked — nothing proves the user controls that number. Off is
                    the branch that sends a verification SMS, which needs a provider below.
                  </p>
                </div>

                {!form.enablePhoneAutoconfirm && form.smsProvider === "" ? (
                  <Alert variant="warning" title="No SMS provider selected">
                    <p>
                      Verification codes are switched on but nothing can deliver them, so
                      phone sign-up will fail. Pick a provider below, or turn auto-confirm
                      back on.
                    </p>
                  </Alert>
                ) : null}

                <Field
                  label="SMS provider"
                  hint="Twilio is delivered by the auth container directly. MSG91 has no driver in GoTrue, so this panel delivers it — the instance calls back here and WHARF sends the message."
                >
                  <select
                    value={form.smsProvider}
                    disabled={!canWrite}
                    onChange={(e) =>
                      setForm({ ...form, smsProvider: e.target.value as SmsProviderDto })
                    }
                    className={INPUT_CLASSES}
                  >
                    <option value="">None — no codes are sent</option>
                    <option value="twilio">Twilio</option>
                    <option value="msg91">MSG91</option>
                  </select>
                </Field>

                {form.smsProvider === "twilio" ? (
                  <>
                    <Field label="Twilio account SID">
                      <input
                        value={form.smsTwilioAccountSid}
                        disabled={!canWrite}
                        onChange={(e) =>
                          setForm({ ...form, smsTwilioAccountSid: e.target.value })
                        }
                        placeholder="AC..."
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <Field label="Twilio auth token">
                      <input
                        type="password"
                        autoComplete="off"
                        value={form.smsTwilioAuthToken}
                        disabled={!canWrite}
                        onChange={(e) =>
                          setForm({ ...form, smsTwilioAuthToken: e.target.value })
                        }
                        placeholder={
                          query.data.smsTwilioAuthTokenConfigured ? "(unchanged)" : ""
                        }
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <Field
                      label="Twilio message service SID"
                      hint="The Messaging Service the codes are sent from, not a phone number."
                    >
                      <input
                        value={form.smsTwilioMessageServiceSid}
                        disabled={!canWrite}
                        onChange={(e) =>
                          setForm({ ...form, smsTwilioMessageServiceSid: e.target.value })
                        }
                        placeholder="MG..."
                        className={INPUT_CLASSES}
                      />
                    </Field>
                  </>
                ) : null}

                {form.smsProvider === "msg91" ? (
                  <>
                    <Field label="MSG91 auth key">
                      <input
                        type="password"
                        autoComplete="off"
                        value={form.smsMsg91AuthKey}
                        disabled={!canWrite}
                        onChange={(e) => setForm({ ...form, smsMsg91AuthKey: e.target.value })}
                        placeholder={query.data.smsMsg91AuthKeyConfigured ? "(unchanged)" : ""}
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <Field
                      label="MSG91 template (flow) ID"
                      hint="The DLT-approved template the code is sent through. MSG91 composes the message from it — the SMS message template field below does not apply to MSG91."
                    >
                      <input
                        value={form.smsMsg91TemplateId}
                        disabled={!canWrite}
                        onChange={(e) =>
                          setForm({ ...form, smsMsg91TemplateId: e.target.value })
                        }
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <Field
                      label="MSG91 sender ID"
                      hint="The registered 6-character header. Leave blank if the template already pins one."
                    >
                      <input
                        value={form.smsMsg91SenderId}
                        disabled={!canWrite}
                        onChange={(e) => setForm({ ...form, smsMsg91SenderId: e.target.value })}
                        placeholder="WHARFX"
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <Field
                      label="OTP template variable"
                      hint="The variable in your MSG91 template that the code is substituted into. Must match the template exactly, or the message arrives with an empty code."
                    >
                      <input
                        value={form.smsMsg91OtpVariable}
                        disabled={!canWrite}
                        onChange={(e) =>
                          setForm({ ...form, smsMsg91OtpVariable: e.target.value })
                        }
                        placeholder="OTP"
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <p className="text-xs text-neutral-500">
                      MSG91 credentials stay in this panel and are never written to the
                      instance. The instance calls WHARF to send each code, so codes stop
                      going out while the panel is unreachable — Twilio, being native to the
                      auth container, has no such dependency.
                    </p>
                  </>
                ) : null}

                {form.smsProvider !== "" ? (
                  <>
                    <Field
                      label="Code length"
                      hint="Between 6 and 10 digits."
                    >
                      <input
                        type="number"
                        min={6}
                        max={10}
                        value={form.smsOtpLength}
                        disabled={!canWrite}
                        onChange={(e) => setForm({ ...form, smsOtpLength: e.target.value })}
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <Field label="Code validity, in seconds">
                      <input
                        type="number"
                        min={10}
                        max={86_400}
                        value={form.smsOtpExp}
                        disabled={!canWrite}
                        onChange={(e) => setForm({ ...form, smsOtpExp: e.target.value })}
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    <Field
                      label="Minimum gap between messages"
                      hint="A Go duration such as 1m0s or 30s — the unit is required."
                    >
                      <input
                        value={form.smsMaxFrequency}
                        disabled={!canWrite}
                        onChange={(e) => setForm({ ...form, smsMaxFrequency: e.target.value })}
                        placeholder="1m0s"
                        className={INPUT_CLASSES}
                      />
                    </Field>
                    {form.smsProvider !== "msg91" ? (
                      <Field
                        label="SMS message template"
                        hint="Use {{ .Code }} where the code should appear. Leave blank for GoTrue's default."
                      >
                        <input
                          value={form.smsTemplate}
                          disabled={!canWrite}
                          onChange={(e) => setForm({ ...form, smsTemplate: e.target.value })}
                          placeholder="Your code is {{ .Code }}"
                          className={INPUT_CLASSES}
                        />
                      </Field>
                    ) : null}
                  </>
                ) : null}
              </ProviderRow>

              <ProviderRow
                icon={<GoogleIcon />}
                name="Google"
                enabled={form.googleEnabled}
                expanded={expandedProvider === "google"}
                onToggleExpand={() => toggleExpanded("google")}
              >
                <Toggle
                  label="Enable Google"
                  checked={form.googleEnabled}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, googleEnabled: v })}
                />
                <Field
                  label="Client IDs"
                  hint="Comma-separate to allow native (Android/iOS), One Tap and Chrome-extension client ids alongside the web one."
                >
                  <input
                    value={form.googleClientId}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, googleClientId: e.target.value })}
                    placeholder="000000000000-xxxx.apps.googleusercontent.com"
                    className={INPUT_CLASSES}
                  />
                </Field>
                <Field
                  label="Client secret"
                  hint="Used by the web OAuth flow. Native ID-token sign-in doesn't need one."
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.googleSecret}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, googleSecret: e.target.value })}
                    placeholder={query.data.googleSecretConfigured ? "(unchanged)" : ""}
                    className={INPUT_CLASSES}
                  />
                </Field>
                <div>
                  <Toggle
                    label="Skip nonce checks"
                    checked={form.googleSkipNonceCheck}
                    disabled={!canWrite}
                    onChange={(v) => setForm({ ...form, googleSkipNonceCheck: v })}
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Accepts ID tokens carrying any nonce. Less secure — it removes a replay
                    protection — but some native SDKs (notably on iOS) don&apos;t expose the
                    nonce they signed with.
                  </p>
                </div>
                <div>
                  <Toggle
                    label="Allow users without an email"
                    checked={form.googleEmailOptional}
                    disabled={!canWrite}
                    onChange={(v) => setForm({ ...form, googleEmailOptional: v })}
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Lets sign-in succeed when Google returns no email address. Off means such
                    an attempt is rejected.
                  </p>
                </div>
                <MonoField label="Callback URL (for OAuth)" value={effectiveCallbackUrl} />
                <p className="-mt-2 text-xs text-neutral-500">
                  Add this as an Authorized redirect URI on the Google Cloud OAuth client.
                  It must match exactly, or Google rejects the flow with
                  redirect_uri_mismatch.
                </p>
              </ProviderRow>

              <ProviderRow
                icon={<GithubIcon />}
                name="GitHub"
                enabled={form.githubEnabled}
                expanded={expandedProvider === "github"}
                onToggleExpand={() => toggleExpanded("github")}
              >
                <Toggle
                  label="Enable GitHub"
                  checked={form.githubEnabled}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, githubEnabled: v })}
                />
                <Field label="Client ID">
                  <input
                    value={form.githubClientId}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, githubClientId: e.target.value })}
                    className={INPUT_CLASSES}
                  />
                </Field>
                <Field
                  label="Client secret"
                  hint="Register an OAuth app with this instance's callback URL (below) as the redirect URI."
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.githubSecret}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, githubSecret: e.target.value })}
                    placeholder={query.data.githubSecretConfigured ? "(unchanged)" : ""}
                    className={INPUT_CLASSES}
                  />
                </Field>
              </ProviderRow>

              <ProviderRow
                icon={<AzureIcon />}
                name="Azure"
                enabled={form.azureEnabled}
                expanded={expandedProvider === "azure"}
                onToggleExpand={() => toggleExpanded("azure")}
              >
                <Toggle
                  label="Enable Azure"
                  checked={form.azureEnabled}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, azureEnabled: v })}
                />
                <Field label="Client ID">
                  <input
                    value={form.azureClientId}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, azureClientId: e.target.value })}
                    className={INPUT_CLASSES}
                  />
                </Field>
                <Field
                  label="Client secret"
                  hint="Register an OAuth app with this instance's callback URL (below) as the redirect URI."
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.azureSecret}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, azureSecret: e.target.value })}
                    placeholder={query.data.azureSecretConfigured ? "(unchanged)" : ""}
                    className={INPUT_CLASSES}
                  />
                </Field>
              </ProviderRow>

              <ProviderRow
                icon={<AppleIcon />}
                name="Apple"
                enabled={form.appleEnabled}
                expanded={expandedProvider === "apple"}
                onToggleExpand={() => toggleExpanded("apple")}
              >
                <Toggle
                  label="Enable Apple"
                  checked={form.appleEnabled}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, appleEnabled: v })}
                />
                <Field
                  label="Client IDs (Services ID)"
                  hint="Apple's equivalent of a client ID, e.g. com.example.app.web. Comma-separate to add a native app's bundle ID alongside it."
                >
                  <input
                    value={form.appleClientId}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, appleClientId: e.target.value })}
                    placeholder="com.example.app.web"
                    className={INPUT_CLASSES}
                  />
                </Field>
                <Field
                  label="Secret key (generated JWT)"
                  hint="Not a secret Apple hands you — a JWT you sign yourself with your .p8 key. Apple caps it at 6 months, so it expires and has to be regenerated and re-saved here, or web sign-in stops working."
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.appleSecret}
                    disabled={!canWrite}
                    onChange={(e) => setForm({ ...form, appleSecret: e.target.value })}
                    placeholder={query.data.appleSecretConfigured ? "(unchanged)" : ""}
                    className={INPUT_CLASSES}
                  />
                </Field>
                <div>
                  <Toggle
                    label="Allow users without an email"
                    checked={form.appleEmailOptional}
                    disabled={!canWrite}
                    onChange={(v) => setForm({ ...form, appleEmailOptional: v })}
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Worth enabling for Apple specifically: it releases an email only on the
                    user&apos;s first consent, and &quot;Hide My Email&quot; substitutes a
                    private relay address.
                  </p>
                </div>
                <MonoField label="Callback URL (for OAuth)" value={effectiveCallbackUrl} />
                <p className="-mt-2 text-xs text-neutral-500">
                  Register this as a Return URL on the Services ID in the Apple Developer
                  Center.
                </p>
              </ProviderRow>
            </div>
          </div>
        ) : null}
      </SettingsShell>
    </form>
  );
}
