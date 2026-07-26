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
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  fetchAuthSettings,
  updateAuthSettings,
  type AuthSettingsDto,
  type AuthSettingsUpdatePayload,
  type InstanceDto,
} from "./api";

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

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-2.5">
        <div className="mt-0.5 text-neutral-400">{icon}</div>
        <div>
          <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
          <p className="mt-0.5 text-[13px] text-neutral-500">{description}</p>
        </div>
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
    </Card>
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
  enableAnonymousUsers: boolean;
  jwtExpirySeconds: string;
  additionalRedirectUrls: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  smtpSenderName: string;
  smtpAdminEmail: string;
  googleEnabled: boolean;
  googleClientId: string;
  googleSecret: string;
  githubEnabled: boolean;
  githubClientId: string;
  githubSecret: string;
  azureEnabled: boolean;
  azureClientId: string;
  azureSecret: string;
}

function formFromDto(dto: AuthSettingsDto): FormState {
  return {
    disableSignup: dto.disableSignup,
    enableEmailSignup: dto.enableEmailSignup,
    enableEmailAutoconfirm: dto.enableEmailAutoconfirm,
    enablePhoneSignup: dto.enablePhoneSignup,
    enableAnonymousUsers: dto.enableAnonymousUsers,
    jwtExpirySeconds: String(dto.jwtExpirySeconds),
    additionalRedirectUrls: dto.additionalRedirectUrls,
    smtpHost: dto.smtpHost,
    smtpPort: String(dto.smtpPort),
    smtpUser: dto.smtpUser,
    smtpPass: "",
    smtpSenderName: dto.smtpSenderName,
    smtpAdminEmail: dto.smtpAdminEmail,
    googleEnabled: dto.googleEnabled,
    googleClientId: dto.googleClientId,
    googleSecret: "",
    githubEnabled: dto.githubEnabled,
    githubClientId: dto.githubClientId,
    githubSecret: "",
    azureEnabled: dto.azureEnabled,
    azureClientId: dto.azureClientId,
    azureSecret: "",
  };
}

function toPayload(form: FormState): AuthSettingsUpdatePayload {
  return {
    disableSignup: form.disableSignup,
    enableEmailSignup: form.enableEmailSignup,
    enableEmailAutoconfirm: form.enableEmailAutoconfirm,
    enablePhoneSignup: form.enablePhoneSignup,
    enableAnonymousUsers: form.enableAnonymousUsers,
    jwtExpirySeconds: Number(form.jwtExpirySeconds),
    additionalRedirectUrls: form.additionalRedirectUrls,
    smtpHost: form.smtpHost,
    smtpPort: Number(form.smtpPort),
    smtpUser: form.smtpUser,
    ...(form.smtpPass ? { smtpPass: form.smtpPass } : {}),
    smtpSenderName: form.smtpSenderName,
    smtpAdminEmail: form.smtpAdminEmail,
    googleEnabled: form.googleEnabled,
    googleClientId: form.googleClientId,
    ...(form.googleSecret ? { googleSecret: form.googleSecret } : {}),
    githubEnabled: form.githubEnabled,
    githubClientId: form.githubClientId,
    ...(form.githubSecret ? { githubSecret: form.githubSecret } : {}),
    azureEnabled: form.azureEnabled,
    azureClientId: form.azureClientId,
    ...(form.azureSecret ? { azureSecret: form.azureSecret } : {}),
  };
}

export function AuthSettingsForm({ instance, role }: { instance: InstanceDto; role: Role }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(role, "instance.auth-settings.write");
  const queryKey = ["auth-settings", instance.id];

  const query = useQuery({
    queryKey,
    queryFn: () => fetchAuthSettings(instance.id),
  });

  const [form, setForm] = useState<FormState | null>(null);
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

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex max-w-[720px] flex-col gap-4 p-6">
      {!canWrite ? (
        <Alert variant="info">
          Viewing only — changing Auth settings requires the admin role.
        </Alert>
      ) : null}

      <Section
        icon={<ShieldCheck size={18} strokeWidth={1.75} />}
        title="Sign-up & sessions"
        description="Mirrors GoTrue's own env-var-driven config — the same settings Studio's Configuration pages would show, if self-hosted Studio rendered them."
      >
        <Toggle
          label="Disable new sign-ups entirely"
          checked={form.disableSignup}
          disabled={!canWrite}
          onChange={(v) => setForm({ ...form, disableSignup: v })}
        />
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
          label="Additional redirect URLs"
          hint="Comma-separated. Extra URLs GoTrue will allow redirecting to after auth, beyond this instance's own origin."
        >
          <input
            value={form.additionalRedirectUrls}
            disabled={!canWrite}
            onChange={(e) => setForm({ ...form, additionalRedirectUrls: e.target.value })}
            placeholder="https://app.example.com/callback"
            className={INPUT_CLASSES}
          />
        </Field>
      </Section>

      <Section
        icon={<Mail size={18} strokeWidth={1.75} />}
        title="SMTP"
        description="Without a real relay configured, email sign-ups auto-confirm instead of sending a confirmation mail (the default above) — set these and turn autoconfirm off for a real sign-up flow."
      >
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
      </Section>

      <Card className="overflow-hidden p-0">
        <div className="flex items-start gap-2.5 p-5 pb-4">
          <div className="mt-0.5 text-neutral-400">
            <KeyRound size={18} strokeWidth={1.75} />
          </div>
          <div>
            <h3 className="text-[14.5px] font-semibold text-ink">Auth Providers</h3>
            <p className="mt-0.5 text-[13px] text-neutral-500">
              Authenticate your users through a suite of providers and login methods.
            </p>
          </div>
        </div>

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
          <p className="text-xs text-neutral-500">
            Sends OTPs via an SMS provider (Twilio, MessageBird, ...) — not wired up
            self-hosted yet, so phone sign-up will accept the toggle but cannot send codes
            until that&apos;s added.
          </p>
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
          <Field label="Client ID">
            <input
              value={form.googleClientId}
              disabled={!canWrite}
              onChange={(e) => setForm({ ...form, googleClientId: e.target.value })}
              className={INPUT_CLASSES}
            />
          </Field>
          <Field
            label="Client secret"
            hint="Register an OAuth app with this instance's API URL + /callback as the redirect URI."
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
            hint="Register an OAuth app with this instance's API URL + /callback as the redirect URI."
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
            hint="Register an OAuth app with this instance's API URL + /callback as the redirect URI."
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
      </Card>

      {canWrite ? (
        <div className="flex justify-end pb-4">
          <Button type="submit" variant="accent" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save & restart auth"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
