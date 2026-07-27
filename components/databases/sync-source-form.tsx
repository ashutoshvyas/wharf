"use client";

/**
 * Sync source form — where a live-database sync pulls FROM, rendered
 * inside the Restore / Sync modal's "Live database" mode.
 *
 * Two shapes of the same connection:
 *  - **Supabase** — a hosted project. Adds the project URL + service_role key,
 *    which exist only to copy storage OBJECTS over the Storage HTTP API (the
 *    data itself always comes over Postgres, there is no dump API).
 *  - **Postgres** — anything else reachable (Neon, RDS, another WHARF
 *    instance). Storage copying is unavailable, so those fields are hidden.
 *
 * The database host is always editable and never derived from the project
 * ref: hosted projects increasingly hand out a regional pooler host
 * (`aws-0-<region>.pooler.supabase.com`) that the ref alone does not tell you.
 * The hint points at where to copy it from.
 *
 * Secret fields render blank with an "(unchanged)" placeholder once stored —
 * the same convention as server-form-modal.tsx's edit mode; an empty value
 * means "keep what's saved" all the way through to the API schema.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Database, Loader2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  ApiError,
  SYNC_SOURCE_QUERY_KEY,
  saveSyncSource,
  testSyncSource,
  type SyncSourceDto,
  type SyncSourcePayload,
  type SyncSourceTestDto,
} from "./api";

const INPUT_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none " +
  "disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400";

/** libpq's sslmode values, narrowed to the ones worth offering. */
const SSL_MODES = ["require", "verify-full", "prefer", "disable"] as const;

export interface SyncSourceFormState {
  kind: "supabase" | "postgres";
  pgHost: string;
  pgPort: string;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  pgSslMode: string;
  projectUrl: string;
  serviceRoleKey: string;
  includeAuthUsers: boolean;
  includeStorageObjects: boolean;
  extraSchemas: string;
}

export const EMPTY_SYNC_SOURCE: SyncSourceFormState = {
  kind: "supabase",
  pgHost: "",
  pgPort: "5432",
  pgDatabase: "postgres",
  pgUser: "postgres",
  pgPassword: "",
  pgSslMode: "require",
  projectUrl: "",
  serviceRoleKey: "",
  includeAuthUsers: true,
  includeStorageObjects: false,
  extraSchemas: "",
};

export function stateFromDto(dto: SyncSourceDto): SyncSourceFormState {
  return {
    kind: dto.kind,
    pgHost: dto.pgHost,
    pgPort: String(dto.pgPort),
    pgDatabase: dto.pgDatabase,
    pgUser: dto.pgUser,
    pgPassword: "",
    pgSslMode: dto.pgSslMode,
    projectUrl: dto.projectUrl,
    serviceRoleKey: "",
    includeAuthUsers: dto.includeAuthUsers,
    includeStorageObjects: dto.includeStorageObjects,
    extraSchemas: dto.extraSchemas.join(", "),
  };
}

export function payloadFromState(state: SyncSourceFormState): SyncSourcePayload {
  return {
    kind: state.kind,
    pgHost: state.pgHost.trim(),
    pgPort: Number(state.pgPort) || 5432,
    pgDatabase: state.pgDatabase.trim() || "postgres",
    pgUser: state.pgUser.trim(),
    pgSslMode: state.pgSslMode,
    includeAuthUsers: state.includeAuthUsers,
    // Only ever true for a Supabase source — the storage copy needs its API.
    includeStorageObjects: state.kind === "supabase" && state.includeStorageObjects,
    extraSchemas: state.extraSchemas
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ...(state.pgPassword ? { pgPassword: state.pgPassword } : {}),
    ...(state.kind === "supabase" && state.projectUrl
      ? { projectUrl: state.projectUrl.trim().replace(/\/+$/, "") }
      : {}),
    ...(state.serviceRoleKey ? { serviceRoleKey: state.serviceRoleKey } : {}),
  };
}

/**
 * Client-side pre-check only — the server re-validates authoritatively
 * (lib/instances/sync-source-schema.ts). Returns a message, or null when the
 * form is good enough to save.
 */
export function validateSyncSource(
  state: SyncSourceFormState,
  hasStoredPassword: boolean,
  hasStoredServiceKey: boolean,
): string | null {
  if (!state.pgHost.trim()) return "The database host is required.";
  if (!state.pgUser.trim()) return "The database user is required.";
  if (!state.pgPassword && !hasStoredPassword) return "The database password is required.";
  const port = Number(state.pgPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return "Port must be a number between 1 and 65535.";
  }
  if (state.kind === "supabase" && state.includeStorageObjects) {
    if (!state.projectUrl.trim()) {
      return "Copying storage objects needs the source project URL.";
    }
    if (!/^https:\/\//i.test(state.projectUrl.trim())) {
      return "The project URL must start with https://";
    }
    if (!state.serviceRoleKey && !hasStoredServiceKey) {
      return "Copying storage objects needs the source project's service_role key.";
    }
  }
  return null;
}

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label-track mb-1.5 block text-neutral-500">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div>
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
      {hint ? <p className="ml-[26px] mt-0.5 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export interface SyncSourceFormProps {
  instanceId: string;
  state: SyncSourceFormState;
  onChange: (next: SyncSourceFormState) => void;
  /** From the saved row — drives the "(unchanged)" placeholders. */
  stored: SyncSourceDto | null;
  disabled?: boolean;
}

export function SyncSourceForm({
  instanceId,
  state,
  onChange,
  stored,
  disabled,
}: SyncSourceFormProps) {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<SyncSourceTestDto | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const set = <K extends keyof SyncSourceFormState>(key: K, value: SyncSourceFormState[K]) =>
    onChange({ ...state, [key]: value });

  // Any edit invalidates a previous probe result — it was about other details.
  useEffect(() => {
    setTestResult(null);
    setTestError(null);
  }, [
    state.pgHost,
    state.pgPort,
    state.pgDatabase,
    state.pgUser,
    state.pgPassword,
    state.pgSslMode,
  ]);

  /**
   * Save-then-probe: the probe runs on the managed server against the SAVED
   * row, which is the point — it proves the exact path a sync will take
   * (that server's egress, that TLS mode, those credentials), not something
   * the panel happens to be able to reach.
   */
  const test = useMutation({
    mutationFn: async () => {
      await saveSyncSource(instanceId, payloadFromState(state));
      await queryClient.invalidateQueries({ queryKey: SYNC_SOURCE_QUERY_KEY });
      return testSyncSource(instanceId);
    },
    onSuccess: (result) => {
      setTestError(null);
      setTestResult(result);
    },
    onError: (err: Error) => {
      setTestResult(null);
      setTestError(
        err instanceof ApiError && err.status === 409
          ? `${err.message} — try again once that job finishes.`
          : err.message,
      );
    },
  });

  const validationError = validateSyncSource(
    state,
    !!stored?.pgPasswordConfigured,
    !!stored?.serviceRoleKeyConfigured,
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="label-track mb-1.5 block text-neutral-500">Source type</span>
        <div className="flex items-center gap-1 rounded-[8px] bg-neutral-100 p-0.5">
          {(
            [
              { key: "supabase" as const, label: "Supabase project" },
              { key: "postgres" as const, label: "Other Postgres" },
            ]
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              disabled={disabled}
              onClick={() => set("kind", opt.key)}
              className={cn(
                "flex-1 rounded-[6px] px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400",
                state.kind === opt.key
                  ? "bg-white text-ink shadow-sm"
                  : "text-neutral-500 hover:text-ink",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {state.kind === "supabase" ? (
        <Field
          label="Project URL"
          hint="Your project's API URL — Supabase dashboard → Project Settings → Data API. Only needed to copy storage objects."
        >
          <input
            value={state.projectUrl}
            onChange={(e) => set("projectUrl", e.target.value)}
            placeholder="https://abcdefghijklm.supabase.co"
            spellCheck={false}
            disabled={disabled}
            className={INPUT_CLASSES}
          />
        </Field>
      ) : null}

      <div className="grid grid-cols-[1fr_110px] gap-3">
        <Field
          label="Database host"
          hint={
            state.kind === "supabase"
              ? "Copy it from the dashboard's Connect dialog — a pooler host (aws-0-….pooler.supabase.com) is normal and works here."
              : "Hostname or IP the managed server can reach."
          }
        >
          <input
            value={state.pgHost}
            onChange={(e) => set("pgHost", e.target.value)}
            placeholder={
              state.kind === "supabase" ? "db.abcdefghijklm.supabase.co" : "db.internal"
            }
            spellCheck={false}
            disabled={disabled}
            className={`${INPUT_CLASSES} font-mono text-[13px]`}
          />
        </Field>
        <Field label="Port">
          <input
            value={state.pgPort}
            onChange={(e) => set("pgPort", e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            disabled={disabled}
            className={`${INPUT_CLASSES} font-mono text-[13px]`}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Database">
          <input
            value={state.pgDatabase}
            onChange={(e) => set("pgDatabase", e.target.value)}
            spellCheck={false}
            disabled={disabled}
            className={`${INPUT_CLASSES} font-mono text-[13px]`}
          />
        </Field>
        <Field
          label="User"
          hint={state.kind === "supabase" ? "Often postgres.<project-ref> on a pooler." : undefined}
        >
          <input
            value={state.pgUser}
            onChange={(e) => set("pgUser", e.target.value)}
            spellCheck={false}
            disabled={disabled}
            className={`${INPUT_CLASSES} font-mono text-[13px]`}
          />
        </Field>
      </div>

      <div className="grid grid-cols-[1fr_140px] gap-3">
        <Field label="Password">
          <input
            type="password"
            value={state.pgPassword}
            onChange={(e) => set("pgPassword", e.target.value)}
            placeholder={stored?.pgPasswordConfigured ? "(unchanged)" : ""}
            autoComplete="off"
            disabled={disabled}
            className={INPUT_CLASSES}
          />
        </Field>
        <Field label="TLS">
          <select
            value={state.pgSslMode}
            onChange={(e) => set("pgSslMode", e.target.value)}
            disabled={disabled}
            className={INPUT_CLASSES}
          >
            {SSL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-col gap-2.5 rounded-[8px] border border-neutral-200 bg-neutral-50 p-3">
        <span className="label-track text-neutral-500">What to copy</span>
        <p className="text-xs text-neutral-500">
          The <span className="font-mono text-[11.5px] text-ink">public</span> schema
          (and any extra schemas below) is always copied, structure and data.
        </p>
        <Toggle
          label="Auth users"
          hint="Copies auth.users / identities as data only, so existing sign-ins keep working."
          checked={state.includeAuthUsers}
          onChange={(v) => set("includeAuthUsers", v)}
          disabled={disabled}
        />
        {state.kind === "supabase" ? (
          <Toggle
            label="Storage objects (the files themselves)"
            hint="Downloads every object from the source project and re-uploads it into this instance. Needs the project URL and its service_role key."
            checked={state.includeStorageObjects}
            onChange={(v) => set("includeStorageObjects", v)}
            disabled={disabled}
          />
        ) : (
          <p className="text-xs text-neutral-500">
            Storage objects can only be copied from a Supabase project — a plain
            Postgres source has no Storage API to read them from.
          </p>
        )}
      </div>

      {state.kind === "supabase" && state.includeStorageObjects ? (
        <Field
          label="service_role key"
          hint="Read from the source project only — Project Settings → API keys. Stored encrypted."
        >
          <input
            type="password"
            value={state.serviceRoleKey}
            onChange={(e) => set("serviceRoleKey", e.target.value)}
            placeholder={stored?.serviceRoleKeyConfigured ? "(unchanged)" : ""}
            autoComplete="off"
            disabled={disabled}
            className={INPUT_CLASSES}
          />
        </Field>
      ) : null}

      <Field
        label="Extra schemas"
        hint="Comma-separated, in addition to public. Leave blank unless the source keeps app tables elsewhere."
      >
        <input
          value={state.extraSchemas}
          onChange={(e) => set("extraSchemas", e.target.value)}
          placeholder="analytics, billing"
          spellCheck={false}
          disabled={disabled}
          className={`${INPUT_CLASSES} font-mono text-[13px]`}
        />
      </Field>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => test.mutate()}
          disabled={disabled || test.isPending || validationError !== null}
        >
          {test.isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              Testing…
            </span>
          ) : (
            "Save & test connection"
          )}
        </Button>
        {testResult?.ok ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-success">
            <CircleCheck size={15} strokeWidth={1.75} />
            Connected
          </span>
        ) : null}
        {testResult && !testResult.ok ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-danger">
            <CircleX size={15} strokeWidth={1.75} />
            Refused
          </span>
        ) : null}
      </div>

      {testResult ? (
        <Alert
          variant={testResult.ok ? "info" : "danger"}
          icon={<Database size={17} strokeWidth={1.75} />}
        >
          <span className="break-all font-mono text-[12px]">{testResult.detail}</span>
        </Alert>
      ) : null}
      {testError ? <Alert variant="danger">{testError}</Alert> : null}
    </div>
  );
}
