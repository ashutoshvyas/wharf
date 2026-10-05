"use client";

/**
 * New instance modal (design §5.7 AS REVISED + contract §3/§7).
 *
 * Bootstrap policy: preparation is part of provisioning (architecture §4.1),
 * so every reachable server is selectable. A
 * server that is not yet a database host carries an inline note plus the
 * wildcard-DNS record it will need, because selecting it is the moment that
 * record starts to matter.
 *
 * The instance domain is rendered by the server component from
 * `process.env.INSTANCE_DOMAIN` and threaded down as a prop — deliberately not
 * a NEXT_PUBLIC_ variable.
 *
 * After submit the modal turns into the progress view. It stays closable:
 * closing does NOT cancel anything, the fleet card keeps streaming.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Globe } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { fetchServers, type ServerDto } from "@/components/servers/api";
import {
  ApiError,
  INSTANCES_QUERY_KEY,
  SLUG_MAX,
  SLUG_RE,
  checkSlugAvailable,
  createInstance,
  slugify,
} from "./api";
import { ProvisionProgress } from "./provision-progress";
import type { InstanceSslMode } from "@/lib/instances/ssl-mode";

const INPUT_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

const MONO_INPUT_CLASSES = `${INPUT_CLASSES} font-mono text-[13px]`;

const SLUG_DEBOUNCE_MS = 350;

type SlugCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "taken" }
  | { state: "unknown"; message: string };

export interface NewInstanceModalProps {
  open: boolean;
  onClose: () => void;
  /** Instance apex domain from the server component (INSTANCE_DOMAIN). */
  domain: string;
  /** Told the id of the instance being provisioned so the fleet card stays quiet. */
  onProvisioning?: (instanceId: string | null) => void;
}

export function NewInstanceModal({
  open,
  onClose,
  domain,
  onProvisioning,
}: NewInstanceModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [serverId, setServerId] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [sslMode, setSslMode] = useState<InstanceSslMode>("require");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugCheck, setSlugCheck] = useState<SlugCheck>({ state: "idle" });
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [finished, setFinished] = useState<"ok" | "error" | null>(null);
  // Belt-and-braces double-submit guard (isPending flips a tick after click).
  const submitting = useRef(false);

  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: fetchServers,
    enabled: open,
  });

  const all = servers.data ?? [];
  const reachable = all.filter((s) => s.reachable !== false);
  const hiddenCount = all.length - reachable.length;
  const selected: ServerDto | undefined =
    reachable.find((s) => s.id === serverId) ?? reachable[0];

  // Reset every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setServerId("");
    setName("");
    setSlug("");
    setSslMode("require");
    setSlugTouched(false);
    setSlugCheck({ state: "idle" });
    setFormError(null);
    setCreated(null);
    setFinished(null);
    submitting.current = false;
  }, [open]);

  const slugFormatError =
    slug === ""
      ? null
      : slug.length > SLUG_MAX
        ? `Slug must be ${SLUG_MAX} characters or fewer.`
        : SLUG_RE.test(slug)
          ? null
          : "Lowercase letters, numbers and hyphens only — must start with a letter or number.";

  // Debounced uniqueness check (contract §3 slug-available).
  useEffect(() => {
    if (!open || created) return;
    if (slug === "" || slugFormatError) {
      setSlugCheck({ state: "idle" });
      return;
    }
    setSlugCheck({ state: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      checkSlugAvailable(slug)
        .then((res) => {
          if (cancelled) return;
          setSlugCheck({ state: res.available ? "available" : "taken" });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // Availability is advisory — the API validates authoritatively.
          setSlugCheck({
            state: "unknown",
            message:
              err instanceof Error
                ? `Could not check availability — ${err.message}`
                : "Could not check availability.",
          });
        });
    }, SLUG_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, slugFormatError, open, created]);

  const create = useMutation({
    mutationFn: () =>
      createInstance({ serverId: selected?.id ?? "", name: name.trim(), slug, sslMode }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      if (!data.id) {
        // Defensive: without an id there is nothing to stream — the fleet grid
        // still picks the instance up on the next poll.
        toast({ message: "Provisioning started.", variant: "info" });
        onClose();
        return;
      }
      setCreated({ id: data.id, name: name.trim() });
      onProvisioning?.(data.id);
    },
    onError: (err: Error) => {
      submitting.current = false;
      setFormError(
        err instanceof ApiError && err.status === 409
          ? `${err.message} — try again once that job finishes.`
          : err.message,
      );
    },
  });

  const nameError =
    name.trim() === "" ? null : name.trim().length > 64 ? "Name is too long." : null;

  const valid =
    !!selected &&
    name.trim() !== "" &&
    !nameError &&
    slug !== "" &&
    !slugFormatError &&
    slugCheck.state !== "taken" &&
    slugCheck.state !== "checking";

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || submitting.current || create.isPending) return;
    submitting.current = true;
    setFormError(null);
    create.mutate();
  }

  const preview = slug && !slugFormatError ? slug : null;

  return (
    <Dialog open={open} onClose={onClose} wide>
      <ModalHead
        title={created ? `Provisioning — ${created.name}` : "New Supabase instance"}
        onClose={onClose}
      />

      {created ? (
        <>
          <ModalBody>
            <ProvisionProgress
              instanceId={created.id}
              kind="provision"
              title={`${created.name} · ${selected?.name ?? "server"}`}
              onTerminal={(status) => {
                setFinished(status);
                void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
                // A successful provision may have just prepared the server
                // for the first time (architecture §4.1) — refresh its
                // cached query too, or its detail page (and the "Re-run
                // setup" button) stays stale until something unrelated
                // triggers a refetch.
                if (status === "ok" && selected?.id) {
                  void queryClient.invalidateQueries({ queryKey: ["server", selected.id] });
                  void queryClient.invalidateQueries({ queryKey: ["servers"] });
                }
                toast({
                  title: status === "ok" ? "Provisioned" : undefined,
                  message:
                    status === "ok"
                      ? `${created.name} is running.`
                      : `${created.name} failed to provision — the log is kept on its card.`,
                  variant: status === "ok" ? "success" : "danger",
                });
              }}
            />
            <p className="mt-2.5 text-xs text-neutral-500">
              You can close this — provisioning continues on the server and the
              fleet card stays live.
            </p>
          </ModalBody>
          <ModalFoot>
            {/* Studio SSO (Manage) is M5, so "done" is simply Close — the
                instance is already on the fleet grid, running. */}
            <Button
              variant={finished === "ok" ? "primary" : "secondary"}
              onClick={onClose}
            >
              {finished === "ok" ? "Done — back to fleet" : "Close"}
            </Button>
          </ModalFoot>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          <ModalBody className="flex flex-col gap-4">
            {formError ? <Alert variant="danger">{formError}</Alert> : null}

            <div>
              <label
                htmlFor="ni-server"
                className="label-track mb-1.5 block text-neutral-500"
              >
                Target server
              </label>
              {servers.isPending ? (
                <p className="text-[13px] text-neutral-500">Loading servers…</p>
              ) : servers.isError ? (
                <Alert variant="danger">
                  Could not load servers — {servers.error.message}
                </Alert>
              ) : reachable.length === 0 ? (
                <Alert variant="warning" title="No reachable servers.">
                  Register a server (or fix SSH access) before provisioning a
                  database.
                </Alert>
              ) : (
                <>
                  <select
                    id="ni-server"
                    value={selected?.id ?? ""}
                    onChange={(e) => setServerId(e.target.value)}
                    className={INPUT_CLASSES}
                  >
                    {reachable.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} — {s.host}
                        {s.bootstrapped ? "" : " (not yet a database host)"}
                      </option>
                    ))}
                  </select>
                  {hiddenCount > 0 ? (
                    <p className="mt-1.5 text-xs text-neutral-500">
                      {hiddenCount} server{hiddenCount === 1 ? "" : "s"} hidden —
                      unreachable over SSH.
                    </p>
                  ) : null}
                </>
              )}
            </div>

            {selected && !selected.bootstrapped ? (
              <div className="flex flex-col gap-2.5">
                <Alert variant="info" title="This server will be prepared first — adds ~2 min.">
                  Docker, the shared <code className="font-mono text-[12.5px]">traefik</code>{" "}
                  network, Traefik with Let&apos;s Encrypt and the firewall rules
                  are installed as the first phase of this provision. It must
                  have nothing else bound to ports 80 and 443.
                </Alert>
                <Alert
                  variant="warning"
                  icon={<Globe size={17} strokeWidth={1.75} />}
                  title="Wildcard DNS is required for this host."
                >
                  Create{" "}
                  <code className="whitespace-nowrap font-mono text-[12.5px]">
                    *.{domain} → {selected.host}
                  </code>{" "}
                  (A record) once. Both subdomains below then resolve
                  automatically, for every instance on this server.
                </Alert>
              </div>
            ) : null}

            <div>
              <label
                htmlFor="ni-name"
                className="label-track mb-1.5 block text-neutral-500"
              >
                Instance name
              </label>
              <input
                id="ni-name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="clientb-prod"
                autoComplete="off"
                className={INPUT_CLASSES}
              />
              {nameError ? (
                <p className="mt-1 text-[13px] text-danger">{nameError}</p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="ni-slug"
                className="label-track mb-1.5 block text-neutral-500"
              >
                Slug
              </label>
              <input
                id="ni-slug"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                placeholder="clientb-prod"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={
                  slugFormatError !== null || slugCheck.state === "taken"
                }
                className={MONO_INPUT_CLASSES}
              />
              {slugFormatError ? (
                <p className="mt-1 text-[13px] text-danger">{slugFormatError}</p>
              ) : slugCheck.state === "taken" ? (
                <p className="mt-1 text-[13px] text-danger">
                  Slug already in use — subdomains must be unique.
                </p>
              ) : slugCheck.state === "unknown" ? (
                <p className="mt-1 text-xs text-neutral-500">{slugCheck.message}</p>
              ) : slugCheck.state === "checking" ? (
                <p className="mt-1 text-xs text-neutral-500">Checking availability…</p>
              ) : null}
              {preview ? (
                <p className="mt-1.5 font-mono text-[12px] text-neutral-500">
                  →{" "}
                  <b className="font-medium text-cobalt-600">
                    {preview}.{domain}
                  </b>{" "}
                  ·{" "}
                  <b className="font-medium text-cobalt-600">
                    studio-{preview}.{domain}
                  </b>
                </p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="ni-ssl-mode"
                className="label-track mb-1.5 block text-neutral-500"
              >
                SSL mode
              </label>
              <select
                id="ni-ssl-mode"
                value={sslMode}
                onChange={(e) => setSslMode(e.target.value as InstanceSslMode)}
                aria-describedby="ni-ssl-mode-help"
                className={INPUT_CLASSES}
              >
                <option value="require">Require TLS (recommended)</option>
                <option value="disable">Disable TLS enforcement</option>
              </select>
              <p id="ni-ssl-mode-help" className="mt-1.5 text-xs leading-5 text-neutral-500">
                {sslMode === "require"
                  ? "Connections must negotiate TLS. Plaintext clients are rejected by the shared pooler."
                  : "Compatibility mode: plaintext connections are accepted and credentials may cross the network unencrypted."}
              </p>
            </div>

            <Alert
              variant="info"
              icon={<Database size={17} strokeWidth={1.75} />}
            >
              Provisioning generates secrets, renders the compose file with
              Traefik labels, uploads over SSH and health-checks the stack.
              Certificates are issued on the first request. Database
              connections start allowed from all reachable addresses; open
              Manage → Network access after provisioning if you want to add
              restrictions. The Supabase HTTPS API and Studio are available
              independently.
            </Alert>
          </ModalBody>
          <ModalFoot>
            <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="accent"
              disabled={!valid || create.isPending}
            >
              {create.isPending ? "Starting…" : "Provision instance"}
            </Button>
          </ModalFoot>
        </form>
      )}
    </Dialog>
  );
}
