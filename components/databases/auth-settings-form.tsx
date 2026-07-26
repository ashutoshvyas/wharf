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
import { KeyRound, Mail, ShieldCheck } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
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
        <Toggle
          label="Allow phone sign-up"
          checked={form.enablePhoneSignup}
          disabled={!canWrite}
          onChange={(v) => setForm({ ...form, enablePhoneSignup: v })}
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

      <Section
        icon={<KeyRound size={18} strokeWidth={1.75} />}
        title="OAuth providers"
        description="Google, GitHub, and Azure sign-in. Each needs its own OAuth app registered with that provider, using this instance's API URL + /callback as the redirect URI."
      >
        <Toggle
          label="Enable Google"
          checked={form.googleEnabled}
          disabled={!canWrite}
          onChange={(v) => setForm({ ...form, googleEnabled: v })}
        />
        <Field label="Google client ID">
          <input
            value={form.googleClientId}
            disabled={!canWrite}
            onChange={(e) => setForm({ ...form, googleClientId: e.target.value })}
            className={INPUT_CLASSES}
          />
        </Field>
        <Field label="Google client secret">
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

        <div className="border-t border-neutral-100 pt-3.5">
          <Toggle
            label="Enable GitHub"
            checked={form.githubEnabled}
            disabled={!canWrite}
            onChange={(v) => setForm({ ...form, githubEnabled: v })}
          />
        </div>
        <Field label="GitHub client ID">
          <input
            value={form.githubClientId}
            disabled={!canWrite}
            onChange={(e) => setForm({ ...form, githubClientId: e.target.value })}
            className={INPUT_CLASSES}
          />
        </Field>
        <Field label="GitHub client secret">
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

        <div className="border-t border-neutral-100 pt-3.5">
          <Toggle
            label="Enable Azure"
            checked={form.azureEnabled}
            disabled={!canWrite}
            onChange={(v) => setForm({ ...form, azureEnabled: v })}
          />
        </div>
        <Field label="Azure client ID">
          <input
            value={form.azureClientId}
            disabled={!canWrite}
            onChange={(e) => setForm({ ...form, azureClientId: e.target.value })}
            className={INPUT_CLASSES}
          />
        </Field>
        <Field label="Azure client secret">
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
      </Section>

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
