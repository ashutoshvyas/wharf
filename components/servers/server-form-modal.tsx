"use client";

/**
 * Register / Edit server modal (, design §5.3 + prototype serverModal()).
 *
 * - Auth method is a two-button segmented control (prototype .seg style).
 * - Create mode: paste a PEM private key OR use a password; a panel-managed
 *   keypair can only be generated after registration (the endpoint needs a
 *   server id), so create mode shows a hint pointing at the server page.
 * - Edit mode: secret fields show "(unchanged)" and empty = keep (the PATCH
 *   contract); "Generate keypair" is available inline — replacing an
 *   existing key asks for confirmation (POST keypair {confirm:true}) and the
 *   returned public key is shown ONCE in a MonoField.
 * - Client-side validation runs the real lib/servers/schema.ts zod schemas
 *   so inline messages match the API's exactly.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  serverCreateSchema,
  serverUpdateSchema,
} from "@/lib/servers/schema";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { MonoField } from "@/components/ui/mono-field";
import { useToast } from "@/components/ui/toast";
import {
  createServer,
  generateKeypair,
  updateServer,
  type ServerDto,
  type ServerPayload,
} from "./api";

const INPUT_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none " +
  "disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400";

const MONO_INPUT_CLASSES = `${INPUT_CLASSES} font-mono text-[13px]`;

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="label-track mb-1.5 block text-neutral-500">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-[13px] text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-neutral-500">{hint}</p>
      ) : null}
    </div>
  );
}

type AuthMethod = "password" | "private_key";

export interface ServerFormModalProps {
  open: boolean;
  onClose: () => void;
  /** null = register mode; a server = edit mode. */
  server: ServerDto | null;
}

export function ServerFormModal({ open, onClose, server }: ServerFormModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = server !== null;

  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [sshUser, setSshUser] = useState("root");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("private_key");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [linkedPanelUrl, setLinkedPanelUrl] = useState("");
  const [panelUser, setPanelUser] = useState("");
  const [panelPass, setPanelPass] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Edit-mode inline keypair generation (shown ONCE by the API).
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [confirmReplaceKey, setConfirmReplaceKey] = useState(false);

  // Reset the form every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setTags(server?.tags.join(", ") ?? "");
    setHost(server?.host ?? "");
    setPort(String(server?.sshPort ?? 22));
    setSshUser(server?.sshUser ?? "root");
    setAuthMethod(server?.authMethod ?? "private_key");
    setSshPassword("");
    setSshPrivateKey("");
    setLinkedPanelUrl(server?.linkedPanelUrl ?? "");
    setPanelUser("");
    setPanelPass("");
    setFormError(null);
    setFieldErrors({});
    setGeneratedKey(null);
    setConfirmReplaceKey(false);
  }, [open, server]);

  const save = useMutation({
    mutationFn: (payload: ServerPayload) =>
      isEdit ? updateServer(server.id, payload) : createServer(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      if (isEdit) {
        void queryClient.invalidateQueries({ queryKey: ["server", server.id] });
      }
      toast({
        message: isEdit
          ? "Server updated"
          : `${name.trim()} registered`,
        variant: "success",
      });
      onClose();
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const keygen = useMutation({
    mutationFn: (confirm: boolean) => generateKeypair(server!.id, confirm),
    onSuccess: (data) => {
      setGeneratedKey(data.publicKey);
      setAuthMethod("private_key");
      setSshPrivateKey("");
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      void queryClient.invalidateQueries({ queryKey: ["server", server?.id] });
    },
    onError: (err: Error) => setFormError(err.message),
  });

  function requestKeypair() {
    setFormError(null);
    if (server?.authMethod === "private_key") {
      // Replacing a stored key — confirm first (the old key stops working).
      setConfirmReplaceKey(true);
    } else {
      keygen.mutate(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const parsedPort = Number.parseInt(port, 10);
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const raw: Record<string, unknown> = {
      name: name.trim(),
      host: host.trim(),
      sshPort: Number.isNaN(parsedPort) ? -1 : parsedPort,
      sshUser: sshUser.trim(),
      authMethod,
      linkedPanelUrl: linkedPanelUrl.trim(),
      tags: tagList,
    };

    if (isEdit) {
      // Empty string secrets mean "keep" — the update schema strips them.
      raw.sshPassword = authMethod === "password" ? sshPassword : "";
      raw.sshPrivateKey = authMethod === "private_key" ? sshPrivateKey.trim() : "";
      raw.panelUser = panelUser.trim();
      raw.panelPass = panelPass;
    } else {
      if (authMethod === "password" && sshPassword !== "") {
        raw.sshPassword = sshPassword;
      }
      if (authMethod === "private_key" && sshPrivateKey.trim() !== "") {
        raw.sshPrivateKey = sshPrivateKey.trim();
      }
      if (panelUser.trim() !== "") raw.panelUser = panelUser.trim();
      if (panelPass !== "") raw.panelPass = panelPass;
    }

    const schema = isEdit ? serverUpdateSchema : serverCreateSchema;
    const result = schema.safeParse(raw);
    if (!result.success) {
      const errors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!(key in errors)) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      setFormError("Fix the highlighted fields and try again.");
      return;
    }
    save.mutate(result.data as ServerPayload);
  }

  const keySecretHint = isEdit
    ? "Paste a new PEM key to replace the stored one — leave empty to keep it."
    : "PEM-encoded key. Stored AES-256-GCM encrypted, never shown again.";

  return (
    <>
      <Dialog open={open} onClose={onClose} wide>
        <ModalHead
          title={isEdit ? "Edit server" : "Register server"}
          onClose={onClose}
        />
        <form onSubmit={handleSubmit}>
          <ModalBody className="flex flex-col gap-4">
            {formError ? <Alert variant="danger">{formError}</Alert> : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="sf-name" label="Name" error={fieldErrors.name}>
                <input
                  id="sf-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="vps-03"
                  autoComplete="off"
                  className={INPUT_CLASSES}
                />
              </Field>
              <Field
                id="sf-tags"
                label="Tags"
                hint="Comma-separated, up to 8."
                error={fieldErrors.tags}
              >
                <input
                  id="sf-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="hetzner, production"
                  autoComplete="off"
                  className={INPUT_CLASSES}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="sf-host" label="Host" error={fieldErrors.host}>
                <input
                  id="sf-host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="203.0.113.10"
                  autoComplete="off"
                  spellCheck={false}
                  className={MONO_INPUT_CLASSES}
                />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field id="sf-port" label="Port" error={fieldErrors.sshPort}>
                  <input
                    id="sf-port"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    className={MONO_INPUT_CLASSES}
                  />
                </Field>
                <Field id="sf-user" label="SSH user" error={fieldErrors.sshUser}>
                  <input
                    id="sf-user"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className={MONO_INPUT_CLASSES}
                  />
                </Field>
              </div>
            </div>

            <div>
              <span className="label-track mb-1.5 block text-neutral-500">
                Auth method
              </span>
              <div
                role="group"
                aria-label="Auth method"
                className="flex overflow-hidden rounded-[6px] border border-neutral-200"
              >
                <button
                  type="button"
                  aria-pressed={authMethod === "private_key"}
                  onClick={() => setAuthMethod("private_key")}
                  className={cn(
                    "flex-1 px-2.5 py-[9px] text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt-400",
                    authMethod === "private_key"
                      ? "bg-cobalt-50 text-cobalt-700"
                      : "bg-white text-neutral-500 hover:text-ink",
                  )}
                >
                  Private key (recommended)
                </button>
                <button
                  type="button"
                  aria-pressed={authMethod === "password"}
                  onClick={() => setAuthMethod("password")}
                  className={cn(
                    "flex-1 border-l border-neutral-200 px-2.5 py-[9px] text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt-400",
                    authMethod === "password"
                      ? "bg-cobalt-50 text-cobalt-700"
                      : "bg-white text-neutral-500 hover:text-ink",
                  )}
                >
                  Password
                </button>
              </div>
            </div>

            {authMethod === "password" ? (
              <Field
                id="sf-pass"
                label="SSH password"
                hint={
                  isEdit
                    ? "Leave empty to keep the stored password."
                    : "Consider a key instead — the panel never needs to store a password then."
                }
                error={fieldErrors.sshPassword}
              >
                <input
                  id="sf-pass"
                  type="password"
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  placeholder={isEdit ? "(unchanged)" : "stored AES-256-GCM encrypted"}
                  autoComplete="new-password"
                  className={MONO_INPUT_CLASSES}
                />
              </Field>
            ) : generatedKey ? (
              <div className="flex flex-col gap-2.5">
                <Alert
                  variant="info"
                  icon={<KeyRound size={17} strokeWidth={1.75} />}
                  title="Keypair generated — shown only once."
                >
                  Paste this public key into{" "}
                  <code className="font-mono text-[12.5px]">
                    ~/.ssh/authorized_keys
                  </code>{" "}
                  on the server now. The private key is stored encrypted; the
                  public key cannot be retrieved again.
                </Alert>
                <MonoField label="Public key" value={generatedKey} />
              </div>
            ) : (
              <Field
                id="sf-privkey"
                label="SSH private key"
                hint={keySecretHint}
                error={fieldErrors.sshPrivateKey}
              >
                {isEdit ? (
                  <div className="mb-2 flex items-center gap-2.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={requestKeypair}
                      disabled={keygen.isPending}
                    >
                      <KeyRound size={14} strokeWidth={1.75} aria-hidden />
                      {keygen.isPending ? "Generating…" : "Generate keypair"}
                    </Button>
                    <span className="text-xs text-neutral-500">
                      or paste a private key:
                    </span>
                  </div>
                ) : null}
                <textarea
                  id="sf-privkey"
                  rows={3}
                  value={sshPrivateKey}
                  onChange={(e) => setSshPrivateKey(e.target.value)}
                  placeholder={
                    isEdit ? "(unchanged)" : "-----BEGIN OPENSSH PRIVATE KEY-----"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className={`${MONO_INPUT_CLASSES} h-auto py-2 text-xs`}
                />
                {!isEdit ? (
                  <p className="mt-1.5 text-xs text-neutral-500">
                    You can generate a panel-managed keypair after registering,
                    from the server page.
                  </p>
                ) : null}
              </Field>
            )}

            <Field
              id="sf-panel"
              label={
                <>
                  Linked panel URL{" "}
                  <span className="normal-case tracking-normal text-neutral-400">
                    (optional)
                  </span>
                </>
              }
              hint="Deep link only — opens in a new tab. Not SSO."
              error={fieldErrors.linkedPanelUrl}
            >
              <input
                id="sf-panel"
                value={linkedPanelUrl}
                onChange={(e) => setLinkedPanelUrl(e.target.value)}
                placeholder="https://cpanel.example.com:2087"
                autoComplete="off"
                spellCheck={false}
                className={MONO_INPUT_CLASSES}
              />
            </Field>

            <div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="sf-puser"
                  label="Panel username"
                  error={fieldErrors.panelUser}
                >
                  <input
                    id="sf-puser"
                    value={panelUser}
                    onChange={(e) => setPanelUser(e.target.value)}
                    placeholder={isEdit && server.hasPanelCredential ? "(unchanged)" : "root"}
                    autoComplete="off"
                    spellCheck={false}
                    className={MONO_INPUT_CLASSES}
                  />
                </Field>
                <Field
                  id="sf-ppass"
                  label="Panel password"
                  error={fieldErrors.panelPass}
                >
                  <input
                    id="sf-ppass"
                    type="password"
                    value={panelPass}
                    onChange={(e) => setPanelPass(e.target.value)}
                    placeholder={isEdit && server.hasPanelCredential ? "(unchanged)" : ""}
                    autoComplete="new-password"
                    className={MONO_INPUT_CLASSES}
                  />
                </Field>
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">
                Optional — stored AES-256-GCM encrypted. Retrieve them any time
                from the server page; every reveal is audited.
              </p>
            </div>
          </ModalBody>
          <ModalFoot>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Register server"}
            </Button>
          </ModalFoot>
        </form>
      </Dialog>

      <ConfirmModal
        open={confirmReplaceKey}
        onClose={() => setConfirmReplaceKey(false)}
        title="Replace SSH keypair"
        variant="danger"
        confirmLabel="Replace keypair"
        busy={keygen.isPending}
        onConfirm={() => {
          setConfirmReplaceKey(false);
          keygen.mutate(true);
        }}
      >
        <b>The stored private key is replaced immediately.</b> The old public
        key stops working the moment you remove it from{" "}
        <code className="font-mono text-[12.5px]">~/.ssh/authorized_keys</code>{" "}
        — make sure you can paste the new one before you do.
      </ConfirmModal>
    </>
  );
}
