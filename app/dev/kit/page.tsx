"use client";

import { useState } from "react";
import {
  Database,
  EllipsisVertical,
  Pencil,
  Plus,
  ScrollText,
  Server,
  Terminal,
  Trash2,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button, ButtonLink, type ButtonVariant } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { LogStream, type LogLine } from "@/components/ui/log-stream";
import { MonoField } from "@/components/ui/mono-field";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge, type Status } from "@/components/ui/status-badge";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";

const BUTTON_VARIANTS: ButtonVariant[] = [
  "primary",
  "accent",
  "secondary",
  "ghost",
  "onDark",
  "danger",
];

const BADGE_VARIANTS: BadgeVariant[] = [
  "cobalt",
  "coral",
  "neutral",
  "onDark",
  "danger",
];

const STATUSES: Status[] = [
  "running",
  "provisioning",
  "stopped",
  "error",
  "removing",
  "working",
  "bootstrapped",
  "not_bootstrapped",
  "unreachable",
];

interface DemoInstance {
  id: string;
  name: string;
  slug: string;
  server: string;
  status: Status;
  created: string;
  pgPass: string;
}

const INSTANCES: DemoInstance[] = [
  {
    id: "db1",
    name: "clienta-prod",
    slug: "clienta",
    server: "vps-01",
    status: "running",
    created: "12 Jun 2026",
    pgPass: "pg_9xKm2LqR8vNw",
  },
  {
    id: "db2",
    name: "acme-staging",
    slug: "acme-staging",
    server: "vps-01",
    status: "stopped",
    created: "9 Jun 2026",
    pgPass: "pg_5tYw8HnB3kLp",
  },
  {
    id: "db3",
    name: "demo-api",
    slug: "demo-api",
    server: "vps-02",
    status: "error",
    created: "22 Jul 2026",
    pgPass: "pg_2wQz6JmX9cVb",
  },
];

const INITIAL_LOG: LogLine[] = [
  { kind: "info", text: "wharf provision · sb_4f2a · vps-01" },
  { kind: "step", text: "Generate secrets" },
  { kind: "ok", text: "JWT secret + anon/service_role keys written" },
  { kind: "step", text: "Render compose file" },
  { kind: "ok", text: "docker-compose.yml rendered (11 services)" },
  { kind: "step", text: "docker compose -p sb_4f2a up -d" },
  { kind: "ok", text: "Network sb_4f2a_default created" },
  { kind: "ok", text: "Container sb_4f2a-db-1 started" },
  { kind: "err", text: "Container sb_4f2a-auth-1 exited (1) — GOTRUE_SITE_URL invalid" },
  { kind: "info", text: "retrying in 5s…" },
];

function Section({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <SectionLabel>{label}</SectionLabel>
      <h2 className="mt-1 mb-4 text-xl font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function KitPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState("overview");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>(INITIAL_LOG);

  function appendLogLine() {
    const kinds: LogLine[] = [
      { kind: "step", text: "Health check attempt" },
      { kind: "ok", text: "kong responded 200 in 84ms" },
      { kind: "info", text: "waiting for auth container…" },
      { kind: "err", text: "auth healthcheck failed (attempt 3)" },
    ];
    const pick = kinds[Math.floor(Math.random() * kinds.length)]!;
    setLogLines((prev) => [...prev, pick]);
  }

  const columns: DataTableColumn<DemoInstance>[] = [
    {
      key: "name",
      header: "Instance",
      render: (r) => <span className="font-semibold text-ink">{r.name}</span>,
    },
    { key: "slug", header: "Slug", mono: true },
    { key: "server", header: "Server", mono: true },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.status} />,
    },
    { key: "created", header: "Created" },
  ];

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10">
      <div className="mx-auto max-w-[1100px]">
        <header className="mb-10">
          <SectionLabel>WHARF · Design system</SectionLabel>
          <h1 className="mt-1 text-[28px] font-bold tracking-[-0.02em] text-ink">
            UI kit review
          </h1>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            Every component, every variant and state. Dev-only page.
          </p>
        </header>

        <Section label="Buttons" title="Button + ButtonLink">
          <Card className="p-6">
            <div className="flex flex-col gap-5">
              {(["sm", "md", "lg"] as const).map((size) => (
                <div key={size} className="flex flex-wrap items-center gap-3">
                  <span className="label-track w-10 text-neutral-500">{size}</span>
                  {BUTTON_VARIANTS.map((variant) =>
                    variant === "onDark" ? (
                      <span
                        key={variant}
                        className="inline-flex rounded-[12px] bg-terminal-bg p-1.5"
                      >
                        <Button variant={variant} size={size}>
                          onDark
                        </Button>
                      </span>
                    ) : (
                      <Button key={variant} variant={variant} size={size}>
                        {variant}
                      </Button>
                    ),
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <span className="label-track w-10 text-neutral-500">off</span>
                {BUTTON_VARIANTS.filter((v) => v !== "onDark").map((variant) => (
                  <Button key={variant} variant={variant} disabled>
                    {variant}
                  </Button>
                ))}
                <ButtonLink href="/dev/kit" variant="secondary">
                  ButtonLink →
                </ButtonLink>
              </div>
            </div>
          </Card>
        </Section>

        <Section label="Badges" title="Badge + StatusBadge">
          <Card className="p-6">
            <div className="mb-5 flex flex-wrap items-center gap-2.5">
              {BADGE_VARIANTS.map((variant) =>
                variant === "onDark" ? (
                  <span
                    key={variant}
                    className="inline-flex rounded-full bg-terminal-bg p-1"
                  >
                    <Badge variant={variant}>onDark</Badge>
                  </span>
                ) : (
                  <Badge key={variant} variant={variant}>
                    {variant}
                  </Badge>
                ),
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {STATUSES.map((status) => (
                <StatusBadge key={status} status={status} />
              ))}
            </div>
          </Card>
        </Section>

        <Section label="Mono values" title="MonoField">
          <Card className="grid gap-4 p-6 md:grid-cols-2">
            <MonoField label="Host" value="root@192.0.2.10:22" />
            <MonoField
              label="Postgres password (local secret)"
              value="pg_9xKm2LqR8vNw"
              secret
            />
            <MonoField
              label="service_role key (async audited reveal)"
              secret
              onReveal={() =>
                new Promise<string>((resolve) =>
                  setTimeout(
                    () =>
                      resolve(
                        "[generated service-role key]",
                      ),
                    1200,
                  ),
                )
              }
            />
            <MonoField
              label="Subdomain"
              value="studio-clienta.wharf.example.com"
            />
          </Card>
        </Section>

        <Section label="Feedback" title="Alert">
          <div className="grid gap-3">
            <Alert variant="info" title="Wildcard DNS required.">
              Create an A record for <code className="rounded bg-neutral-100 px-1.5 font-mono text-xs">*.wharf.example.com</code> pointing to 192.0.2.10 before bootstrapping.
            </Alert>
            <Alert variant="success" title="Instance healthy.">
              All 11 containers passed health checks.
            </Alert>
            <Alert variant="warning" title="Server not bootstrapped.">
              Databases cannot be provisioned until vps-02 is bootstrapped.
            </Alert>
            <Alert variant="danger" title="Provisioning failed.">
              Container sb_e390-auth-1 exited (1). The instance was left in place for inspection.
            </Alert>
          </div>
        </Section>

        <Section label="Navigation" title="Tabs">
          <Card className="p-6">
            <Tabs
              tabs={[
                { id: "overview", label: "Overview" },
                { id: "hosted", label: "Hosted" },
                { id: "terminal", label: "Terminal", attention: true },
              ]}
              value={tab}
              onChange={setTab}
            />
            <p className="mt-4 text-sm text-neutral-500">
              Active tab: <span className="font-mono text-[13px] text-ink">{tab}</span>
            </p>
          </Card>
        </Section>

        <Section label="Data" title="DataTable — expandable rows + row menu">
          <Card>
            <DataTable
              columns={columns}
              rows={INSTANCES}
              rowKey={(r) => r.id}
              renderExpanded={(r) => (
                <div className="grid gap-3 md:grid-cols-2">
                  <MonoField label="Postgres password" value={r.pgPass} secret />
                  <MonoField
                    label="Subdomain"
                    value={`${r.slug}.wharf.example.com`}
                  />
                </div>
              )}
            />
          </Card>
        </Section>

        <Section label="Overlays" title="Dialog · ConfirmModal · DropdownMenu">
          <Card className="flex flex-wrap items-center gap-3 p-6">
            <Button variant="secondary" onClick={() => setDialogOpen(true)}>
              Open dialog
            </Button>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>
              Remove permanently…
            </Button>
            <DropdownMenu
              align="start"
              trigger={
                <Button variant="secondary">
                  <EllipsisVertical size={15} strokeWidth={1.75} /> Menu
                </Button>
              }
              items={[
                {
                  label: "Edit",
                  icon: <Pencil size={14} strokeWidth={1.75} />,
                  onSelect: () => toast({ message: "Edit selected" }),
                },
                {
                  label: "Open terminal",
                  icon: <Terminal size={14} strokeWidth={1.75} />,
                  onSelect: () => toast({ message: "Terminal selected" }),
                },
                { type: "separator" },
                {
                  label: "Remove permanently",
                  icon: <Trash2 size={14} strokeWidth={1.75} />,
                  danger: true,
                  onSelect: () => setConfirmOpen(true),
                },
              ]}
            />
          </Card>

          <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
            <ModalHead title="Register server" onClose={() => setDialogOpen(false)} />
            <ModalBody>
              <p className="mb-4 text-[13.5px] text-neutral-700">
                A plain dialog with focus trap, Escape and overlay-click close.
              </p>
              <MonoField
                label="Public key (shown once)"
                value="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF3k… wharf@panel"
              />
            </ModalBody>
            <ModalFoot>
              <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setDialogOpen(false)}>Register server</Button>
            </ModalFoot>
          </Dialog>

          <ConfirmModal
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Remove clienta-prod permanently"
            typeToConfirm="clienta-prod"
            confirmLabel="Remove permanently"
            onConfirm={() => {
              setConfirmOpen(false);
              toast({
                title: "Removal started",
                message: "clienta-prod is being torn down.",
                variant: "info",
              });
            }}
          >
            Delete containers and all data volumes for{" "}
            <b className="text-ink">clienta-prod</b>. Metadata stays recoverable
            for a grace period, but the database volumes are destroyed
            immediately and permanently. The data cannot be recovered.
          </ConfirmModal>
        </Section>

        <Section label="Feedback" title="Toasts">
          <Card className="flex flex-wrap items-center gap-3 p-6">
            <Button
              variant="secondary"
              onClick={() => toast({ message: "Server registered.", variant: "info" })}
            >
              Info
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                toast({
                  title: "Copied",
                  message: "Value copied to clipboard.",
                  variant: "success",
                })
              }
            >
              Success
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                toast({
                  message: "vps-02 has not been bootstrapped yet.",
                  variant: "warning",
                })
              }
            >
              Warning
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                toast({
                  title: "Provisioning failed",
                  message: "demo-api health checks failed — see logs. (manual dismiss)",
                  variant: "danger",
                })
              }
            >
              Danger
            </Button>
          </Card>
        </Section>

        <Section label="Empty" title="EmptyState">
          <Card>
            <EmptyState
              icon={Server}
              message="No servers yet — register your first server."
              action={
                <Button size="sm" variant="primary">
                  <Plus size={15} strokeWidth={2} /> Add server
                </Button>
              }
            />
          </Card>
        </Section>

        <Section label="Cards" title="Card variants">
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="p-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">resting</span>
                <StatusBadge status="running" />
              </div>
              <p className="text-[13px] text-neutral-500">shadow-sm, border n-200.</p>
            </Card>
            <Card hoverable className="p-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">hoverable</span>
                <StatusBadge status="stopped" />
              </div>
              <p className="text-[13px] text-neutral-500">Lifts to shadow-md on hover.</p>
            </Card>
            <Card glow className="p-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">glow</span>
                <StatusBadge status="provisioning" />
              </div>
              <p className="text-[13px] text-neutral-500">
                shadow-glow — the one active element.
              </p>
            </Card>
          </div>
        </Section>

        <Section label="Streams" title="LogStream">
          <div className="mb-3 flex gap-3">
            <Button size="sm" variant="secondary" onClick={appendLogLine}>
              Append line
            </Button>
          </div>
          <LogStream
            title="wharf provision · sb_4f2a · vps-01"
            lines={logLines}
            rightSlot={<StatusBadge status="provisioning" />}
          />
        </Section>

        <footer className="mt-14 flex items-center gap-3 text-neutral-400">
          <Database size={14} strokeWidth={1.75} />
          <ScrollText size={14} strokeWidth={1.75} />
          <span className="font-mono text-[10px] tracking-[0.1em]">
            WHARF · UI KIT · DEV ONLY
          </span>
        </footer>
      </div>
    </main>
  );
}
