"use client";

/**
 * Server detail screen (design §5.4 + prototype viewServerDetail()).
 *
 * Header (back link, name, StatusBadge, mono host) + Overview / Hosted /
 * Terminal tabs synced to ?tab=. Overview: Connection card (host, ssh
 * summary, host-key TOFU state, reachability check, keypair generation with
 * show-once public key), Linked panel card (audited credential reveals), and
 * the bootstrap card. The terminal is available to operators and admins on
 * reachable servers.
 */
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  KeyRound,
  Pencil,
  RadioTower,
  SquareTerminal,
} from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { EmptyState } from "@/components/ui/empty-state";
import { MonoField } from "@/components/ui/mono-field";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { HostedList } from "@/components/servers/hosted-list";
import { SshTerminal } from "@/components/terminal/terminal";
import {
  ApiError,
  checkServer,
  fetchPanelCredential,
  fetchServer,
  generateKeypair,
  type PanelCredentialDto,
  type ServerDto,
} from "./api";
import { BootstrapCard } from "./bootstrap-card";
import { ServerFormModal } from "./server-form-modal";
import { serverStatus } from "./servers-view";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "hosted", label: "Hosted" },
  { id: "terminal", label: "Terminal" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function ServerDetail({ id, role }: { id: string; role: Role }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const writable = can(role, "servers.write");

  const rawTab = searchParams.get("tab");
  const tab: TabId = TABS.some((t) => t.id === rawTab)
    ? (rawTab as TabId)
    : "overview";

  const [modalOpen, setModalOpen] = useState(false);

  const server = useQuery({
    queryKey: ["server", id],
    queryFn: () => fetchServer(id),
  });

  function setTab(next: string) {
    router.replace(
      next === "overview" ? `/servers/${id}` : `/servers/${id}?tab=${next}`,
      { scroll: false },
    );
  }

  if (server.isPending) {
    return (
      <div>
        <BackLink />
        <Card>
          <p className="px-5 py-10 text-center text-[13px] text-neutral-500">
            Loading server…
          </p>
        </Card>
      </div>
    );
  }

  if (server.isError) {
    const notFound =
      server.error instanceof ApiError && server.error.status === 404;
    return (
      <div>
        <BackLink />
        <Alert
          variant="danger"
          title={notFound ? "Server not found" : "Could not load server"}
        >
          <p>{server.error.message}</p>
          {!notFound ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2.5"
              onClick={() => void server.refetch()}
            >
              Retry
            </Button>
          ) : null}
        </Alert>
      </div>
    );
  }

  const s = server.data;

  return (
    <div>
      <BackLink />
      <div className="mb-1.5 flex flex-wrap items-center gap-3.5">
        <h2 className="text-[26px] font-bold tracking-tight">{s.name}</h2>
        <StatusBadge status={serverStatus(s)} />
        <MonoField value={`${s.sshUser}@${s.host}:${s.sshPort}`} className="min-w-0" />
      </div>

      <Tabs
        className="mt-3.5"
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
        value={tab}
        onChange={setTab}
      />

      <div className="mt-5">
        {tab === "overview" ? (
          <OverviewTab server={s} role={role} onEdit={() => setModalOpen(true)} />
        ) : tab === "hosted" ? (
          <Card>
            <HostedList serverId={s.id} />
          </Card>
        ) : (
          <TerminalTab server={s} role={role} />
        )}
      </div>

      {writable ? (
        <ServerFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          server={s}
        />
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <ButtonLink
      variant="ghost"
      size="sm"
      href="/servers"
      className="-ml-2.5 mb-3"
    >
      <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
      All servers
    </ButtonLink>
  );
}

/* ------------------------------ Overview ------------------------------ */

function OverviewTab({
  server: s,
  role,
  onEdit,
}: {
  server: ServerDto;
  role: Role;
  onEdit: () => void;
}) {
  const writable = can(role, "servers.write");
  const canCheck = can(role, "server.check");
  const canReveal = can(role, "secrets.reveal");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Show-once public key: kept in state (the API cannot return it again),
  // visible until the user changes tab (this component unmounts).
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [confirmReplaceKey, setConfirmReplaceKey] = useState(false);

  // Panel credential — fetched ONCE per mount (the reveal is audited), then
  // shared between the username and password MonoFields.
  const credPromise = useRef<Promise<PanelCredentialDto> | null>(null);
  function getCredential(): Promise<PanelCredentialDto> {
    if (!credPromise.current) {
      credPromise.current = fetchPanelCredential(s.id).catch((err: unknown) => {
        credPromise.current = null; // allow retry after a failure
        throw err;
      });
    }
    return credPromise.current;
  }

  const check = useMutation({
    mutationFn: () => checkServer(s.id),
    onSuccess: (result) => {
      if (result.ok) {
        toast({
          message: `${s.name} is reachable (${result.ms ?? "?"} ms).`,
          variant: "success",
        });
      } else {
        toast({
          title: "Unreachable",
          message: result.error ?? "SSH connection failed.",
          variant: "danger",
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["server", s.id] });
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.status === 429) {
        toast({ message: err.message, variant: "warning" });
      } else {
        toast({ title: "Check failed", message: err.message, variant: "danger" });
      }
    },
  });

  const keygen = useMutation({
    mutationFn: (confirm: boolean) => generateKeypair(s.id, confirm),
    onSuccess: (data) => {
      setGeneratedKey(data.publicKey);
      void queryClient.invalidateQueries({ queryKey: ["server", s.id] });
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Keypair generation failed",
        message: err.message,
        variant: "danger",
      });
    },
  });

  const hasKey = s.authMethod === "private_key";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {/* -------- Connection card -------- */}
        <Card className="p-[22px]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <SectionLabel>Connection</SectionLabel>
            {writable ? (
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Pencil size={14} strokeWidth={1.75} aria-hidden />
                Edit
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-3.5">
            <MonoField label="Host" value={s.host} />

            <div>
              <div className="label-track mb-[5px] text-neutral-500">SSH</div>
              <span className="font-mono text-[12.5px] text-neutral-700">
                {s.sshUser} · port {s.sshPort} ·{" "}
                {hasKey ? "ed25519 key" : "password"}
              </span>
            </div>

            <div>
              <div className="label-track mb-[5px] text-neutral-500">
                Host key
              </div>
              {s.hostKeyFingerprint ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-[12.5px] text-neutral-700">
                    {s.hostKeyFingerprint}
                  </span>
                  <span className="whitespace-nowrap font-mono text-[12px] text-success">
                    ✓ pinned
                  </span>
                </div>
              ) : (
                <span className="font-mono text-[12.5px] text-neutral-400">
                  unverified — pinned on first connect (TOFU)
                </span>
              )}
              {s.reachable === false ? (
                <p className="mt-1 text-[13px] text-danger">
                  Server unreachable — SSH connection failed on the last
                  attempt.
                </p>
              ) : null}
            </div>

            <div>
              <div className="label-track mb-[5px] text-neutral-500">
                Registered
              </div>
              <span className="text-sm text-neutral-700">
                {formatDate(s.createdAt)}
              </span>
            </div>

            <div>
              <div className="label-track mb-[5px] text-neutral-500">Tags</div>
              {s.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {s.tags.map((t) => (
                    <Badge key={t} variant="neutral">
                      {t}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-neutral-400">—</span>
              )}
            </div>

            {canCheck ? (
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => check.mutate()}
                  disabled={check.isPending}
                >
                  <RadioTower size={14} strokeWidth={1.75} aria-hidden />
                  {check.isPending ? "Checking…" : "Check reachability"}
                </Button>
              </div>
            ) : null}

            {writable ? (
              <div className="border-t border-neutral-100 pt-3.5">
                <div className="label-track mb-2.5 text-neutral-500">
                  Panel-managed keypair
                </div>
                {generatedKey ? (
                  <div className="flex flex-col gap-2.5">
                    <Alert
                      variant="info"
                      icon={<KeyRound size={17} strokeWidth={1.75} />}
                      title="Keypair generated — shown only once."
                    >
                      Copy it now and paste it into{" "}
                      <code className="font-mono text-[12.5px]">
                        ~/.ssh/authorized_keys
                      </code>{" "}
                      on the server. It disappears when you leave this tab and
                      cannot be retrieved again.
                    </Alert>
                    <MonoField label="Public key" value={generatedKey} />
                  </div>
                ) : (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={keygen.isPending}
                      onClick={() => {
                        if (hasKey) setConfirmReplaceKey(true);
                        else keygen.mutate(false);
                      }}
                    >
                      <KeyRound size={14} strokeWidth={1.75} aria-hidden />
                      {keygen.isPending
                        ? "Generating…"
                        : hasKey
                          ? "Regenerate keypair…"
                          : "Generate keypair"}
                    </Button>
                    <p className="mt-1.5 text-xs text-neutral-500">
                      Generates an ed25519 keypair; the private key is stored
                      encrypted and the public key is shown once for{" "}
                      <span className="font-mono">authorized_keys</span>.
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </Card>

        {/* -------- Linked panel card -------- */}
        <Card className="p-[22px]">
          <SectionLabel className="mb-4">Linked panel</SectionLabel>
          {s.linkedPanelUrl ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-end gap-2">
                <MonoField
                  label="URL"
                  value={s.linkedPanelUrl}
                  className="min-w-0 flex-1"
                />
                <a
                  href={s.linkedPanelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses("secondary", "sm")}
                >
                  Open
                  <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
                </a>
              </div>
              {s.hasPanelCredential && canReveal ? (
                <>
                  <MonoField
                    label="Panel username"
                    secret
                    onReveal={async () => (await getCredential()).username ?? ""}
                  />
                  <MonoField
                    label="Panel password"
                    secret
                    onReveal={async () => (await getCredential()).password ?? ""}
                  />
                  <p className="text-xs text-neutral-500">
                    Stored encrypted — every reveal is audited.
                  </p>
                </>
              ) : s.hasPanelCredential ? (
                <p className="text-xs text-neutral-500">
                  Credentials are stored — revealing them requires operator
                  role or above.
                </p>
              ) : (
                <p className="text-xs text-neutral-500">
                  No stored credentials — add them via Edit.
                </p>
              )}
              <p className="text-xs text-neutral-500">
                Deep link — sign in with these credentials. True SSO into
                third-party panels isn&apos;t possible without their own token
                system.
              </p>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">
              No linked panel{writable ? " — add a URL via Edit." : "."}
            </p>
          )}
        </Card>
      </div>

      {/* -------- Bootstrap -------- */}
      <BootstrapCard
        server={s}
        role={role}
        onServerChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["server", s.id] });
          void queryClient.invalidateQueries({ queryKey: ["servers"] });
        }}
      />

      <ConfirmModal
        open={confirmReplaceKey}
        onClose={() => setConfirmReplaceKey(false)}
        title="Regenerate SSH keypair"
        variant="danger"
        confirmLabel="Regenerate keypair"
        busy={keygen.isPending}
        onConfirm={() => {
          setConfirmReplaceKey(false);
          keygen.mutate(true);
        }}
      >
        <b>The stored private key is replaced immediately</b> — SSH from the
        panel stops working until you paste the new public key into{" "}
        <code className="font-mono text-[12.5px]">~/.ssh/authorized_keys</code>{" "}
        on <span className="font-mono text-[12.5px] text-ink">{s.name}</span>.
        The old key can no longer be used by WHARF.
      </ConfirmModal>
    </div>
  );
}

/* ------------------------------ Terminal ------------------------------ */

function TerminalTab({ server: s, role }: { server: ServerDto; role: Role }) {
  const allowed = can(role, "terminal");

  if (!allowed) {
    return (
      <Card>
        <EmptyState
          icon={SquareTerminal}
          message="Terminal access requires operator role or above."
        />
      </Card>
    );
  }

  if (s.reachable === false) {
    return (
      <Card>
        <EmptyState
          icon={SquareTerminal}
          message="Server unreachable — SSH connection failed. Run a reachability check from the Overview tab once it is back."
        />
      </Card>
    );
  }

  return (
    <SshTerminal
      key={s.id}
      serverId={s.id}
      serverName={s.name}
      sshUser={s.sshUser}
    />
  );
}
