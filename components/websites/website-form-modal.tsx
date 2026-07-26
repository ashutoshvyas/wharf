"use client";

/**
 * Add / Edit website modal (, design §5.5 + prototype websiteModal()).
 *
 * - Server options come from GET /api/servers (parallel workstream — both
 *   {servers:[...]} and bare-array shapes are handled in ./api).
 * - The database-instance select is disabled with an M4 hint until
 *   GET /api/db-instances exists (404-probed at open time).
 * - Edit mode: the password input stays empty with an "(unchanged)"
 *   placeholder; submitting it empty keeps the stored password.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  createWebsite,
  fetchDbInstanceOptions,
  fetchServerOptions,
  updateWebsite,
  type WebsiteDto,
  type WebsitePayload,
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
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="label-track mb-1.5 block text-neutral-500">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export interface WebsiteFormModalProps {
  open: boolean;
  onClose: () => void;
  /** null = create mode; a website = edit mode. */
  website: WebsiteDto | null;
}

export function WebsiteFormModal({ open, onClose, website }: WebsiteFormModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = website !== null;

  const [domain, setDomain] = useState("");
  const [serverId, setServerId] = useState("");
  const [path, setPath] = useState("");
  const [dbInstanceId, setDbInstanceId] = useState("");
  const [credentialLabel, setCredentialLabel] = useState("Admin login");
  const [accessUsername, setAccessUsername] = useState("");
  const [accessPassword, setAccessPassword] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Reset the form every time the modal opens (fresh create or a new edit target).
  useEffect(() => {
    if (!open) return;
    setDomain(website?.domain ?? "");
    setServerId(website?.serverId ?? "");
    setPath(website?.path ?? "");
    setDbInstanceId(website?.dbInstanceId ?? "");
    setCredentialLabel(website?.credentialLabel ?? "Admin login");
    setAccessUsername("");
    setAccessPassword("");
    setNotes(website?.notes ?? "");
    setFormError(null);
  }, [open, website]);

  const servers = useQuery({
    queryKey: ["servers", "options"],
    queryFn: fetchServerOptions,
    enabled: open,
  });
  const dbInstances = useQuery({
    queryKey: ["db-instances", "options"],
    queryFn: () => fetchDbInstanceOptions(),
    enabled: open,
    retry: false,
  });

  // Default the server select to the first server in create mode.
  useEffect(() => {
    if (!open || isEdit || serverId) return;
    const first = servers.data?.[0];
    if (first) setServerId(first.id);
  }, [open, isEdit, serverId, servers.data]);

  const dbAvailable = dbInstances.data?.available ?? false;
  const dbOptions = dbInstances.data?.instances ?? [];

  const save = useMutation({
    mutationFn: (payload: Partial<WebsitePayload>) =>
      isEdit ? updateWebsite(website.id, payload) : createWebsite(payload as WebsitePayload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["websites"] });
      toast({
        message: isEdit ? "Website updated" : `${domain.trim()} added`,
        variant: "success",
      });
      onClose();
    },
    onError: (err: Error) => setFormError(err.message),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const trimmedDomain = domain.trim().toLowerCase();
    const trimmedPath = path.trim();
    if (!trimmedDomain) return setFormError("Domain is required.");
    if (!serverId) return setFormError("Pick the server this website lives on.");
    if (!trimmedPath.startsWith("/"))
      return setFormError("Filesystem path must be absolute (start with /).");

    const payload: Partial<WebsitePayload> = {
      domain: trimmedDomain,
      serverId,
      path: trimmedPath,
      dbInstanceId: dbInstanceId || null,
      credentialLabel: credentialLabel.trim() || "Admin login",
      notes: notes.trim(),
    };
    // Credential semantics: in edit mode a blank username/password means
    // "keep the stored value" (both are withheld from list responses), so
    // blanks are omitted from the payload. Create mode sends what was typed.
    const username = accessUsername.trim();
    if (!isEdit || username !== "") payload.accessUsername = username;
    if (accessPassword !== "") payload.accessPassword = accessPassword;
    save.mutate(payload);
  }

  return (
    <Dialog open={open} onClose={onClose} wide>
      <ModalHead title={isEdit ? "Edit website" : "Add website"} onClose={onClose} />
      <form onSubmit={handleSubmit}>
        <ModalBody className="flex flex-col gap-4">
          {formError ? <Alert variant="danger">{formError}</Alert> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="wf-domain" label="Domain">
              <input
                id="wf-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="clientb.com"
                autoComplete="off"
                spellCheck={false}
                className={MONO_INPUT_CLASSES}
              />
            </Field>
            <Field
              id="wf-server"
              label="Server"
              hint={
                servers.isError
                  ? "Could not load servers — try again."
                  : servers.data?.length === 0
                    ? "No servers registered yet — add one first."
                    : undefined
              }
            >
              <select
                id="wf-server"
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                disabled={servers.isPending || servers.isError}
                className={INPUT_CLASSES}
              >
                {servers.isPending ? <option value="">Loading…</option> : null}
                {!servers.isPending && !serverId ? (
                  <option value="">— select a server —</option>
                ) : null}
                {(servers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field id="wf-path" label="Filesystem path">
            <input
              id="wf-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/var/www/clientb"
              autoComplete="off"
              spellCheck={false}
              className={MONO_INPUT_CLASSES}
            />
          </Field>

          <Field
            id="wf-db"
            label="Linked database instance"
            hint={!dbAvailable ? "Database instances arrive in M4." : undefined}
          >
            <select
              id="wf-db"
              value={dbInstanceId}
              onChange={(e) => setDbInstanceId(e.target.value)}
              disabled={!dbAvailable}
              className={INPUT_CLASSES}
            >
              <option value="">— none —</option>
              {dbOptions.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="wf-clabel" label="Credential label">
              <input
                id="wf-clabel"
                value={credentialLabel}
                onChange={(e) => setCredentialLabel(e.target.value)}
                placeholder="Admin login / FTP / CMS…"
                maxLength={40}
                autoComplete="off"
                className={INPUT_CLASSES}
              />
            </Field>
            <Field id="wf-cuser" label="Username">
              <input
                id="wf-cuser"
                value={accessUsername}
                onChange={(e) => setAccessUsername(e.target.value)}
                placeholder={isEdit ? "(unchanged if blank on save)" : ""}
                autoComplete="off"
                spellCheck={false}
                className={MONO_INPUT_CLASSES}
              />
            </Field>
          </div>

          <Field
            id="wf-cpass"
            label="Password"
            hint="Stored AES-256-GCM encrypted; decrypted only on reveal (audited)."
          >
            <input
              id="wf-cpass"
              type="password"
              value={accessPassword}
              onChange={(e) => setAccessPassword(e.target.value)}
              placeholder={isEdit ? "(unchanged)" : ""}
              autoComplete="new-password"
              className={MONO_INPUT_CLASSES}
            />
          </Field>

          <Field id="wf-notes" label="Notes">
            <textarea
              id="wf-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              className={`${INPUT_CLASSES} h-auto py-2`}
            />
          </Field>
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
                : "Add website"}
          </Button>
        </ModalFoot>
      </form>
    </Dialog>
  );
}
