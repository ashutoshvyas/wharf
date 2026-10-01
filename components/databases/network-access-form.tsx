"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import {
  baselineAllowedCidrsSchema, networkAccessSchema,
  type NetworkAccessDto, type NetworkAccessPolicy,
} from "@/lib/instances/network-access";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { enableServerNetworkAccess, fetchNetworkAccess, updateNetworkAccess, type InstanceDto } from "./api";

const INPUT = "mt-1.5 min-h-11 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 disabled:opacity-60 sm:text-sm";
const rangesFromText = (text: string) => text.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);

export function NetworkAccessForm({ instance, role }: { instance: InstanceDto; role: Role }) {
  const query = useQuery({
    queryKey: ["network-access", instance.id], queryFn: () => fetchNetworkAccess(instance.id),
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <p className="p-6 text-sm text-neutral-600" role="status">Loading network access…</p>;
  if (query.isError) return <div className="p-6"><Alert variant="danger" title="Could not load network access">
    <p>{query.error.message}</p><Button variant="secondary" className="mt-3" onClick={() => void query.refetch()}>Retry</Button>
  </Alert></div>;
  return <NetworkAccessEditor key={instance.id} instance={instance} role={role} data={query.data} />;
}

function NetworkAccessEditor({ instance, role, data }: { instance: InstanceDto; role: Role; data: NetworkAccessDto }) {
  const canWrite = can(role, "instance.network-access.write");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<NetworkAccessPolicy["mode"]>(data.policy?.mode ?? "all");
  const [ranges, setRanges] = useState(data.policy?.mode === "restricted" ? data.policy.allowedCidrs.join("\n") : "");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => {
    setMode(data.policy?.mode ?? "all");
    setRanges(data.policy?.mode === "restricted" ? data.policy.allowedCidrs.join("\n") : "");
  }, [data.policy]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["network-access"] });
  const save = useMutation({
    mutationFn: (policy: NetworkAccessPolicy) => updateNetworkAccess(instance.id, policy),
    onSuccess: async (result) => {
      toast({ title: result.applied ? "Network access applied" : "Saved, awaiting application",
        message: result.applied ? `Updated database access for ${instance.name}.` : result.applyError ?? "Retry applying the saved settings.",
        variant: result.applied ? "success" : "danger" });
      await refresh();
    },
  });
  const setup = useMutation({
    mutationFn: (cidrs: string[]) => enableServerNetworkAccess(data.server.id, confirmName, cidrs),
    onSuccess: async (result) => {
      if (!result.applied) {
        setSetupError(result.applyError ?? "Server setup did not finish. Retry setup.");
        await refresh();
        return;
      }
      toast({ title: "Server network access enabled", message: "Each database now uses its own access policy.", variant: "success" });
      await refresh();
    },
  });
  const busy = save.isPending || setup.isPending;
  const draft = mode === "restricted" ? { mode, allowedCidrs: rangesFromText(ranges) } : { mode };
  const changed = JSON.stringify(draft) !== JSON.stringify(data.policy);

  function savePolicy(event: React.FormEvent) {
    event.preventDefault();
    const parsed = networkAccessSchema.safeParse(draft);
    if (!parsed.success) { setValidationError(parsed.error.issues[0]?.message ?? "Check the addresses."); return; }
    setValidationError(null);
    save.mutate(parsed.data);
  }

  function setupServer(event: React.FormEvent) {
    event.preventDefault();
    const parsed = baselineAllowedCidrsSchema.safeParse(rangesFromText(baseline));
    if (!parsed.success) { setSetupError(parsed.error.issues[0]?.message ?? "Check the baseline addresses."); return; }
    setSetupError(null);
    setup.mutate(parsed.data);
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-1 shrink-0 text-cobalt-600" size={22} aria-hidden />
        <div><h2 className="text-lg font-semibold text-ink">Network access</h2>
          <p className="mt-1 text-sm leading-6 text-neutral-600">Choose which servers can connect to {instance.name}&apos;s database on ports 5432 and 6543. Supabase API and Studio access are separate.</p></div>
      </div>

      {!canWrite && <Alert>Viewing only. An administrator can change network access.</Alert>}
      {data.applyError ? <Alert variant="warning" title="Saved settings are not confirmed active">{data.applyError}</Alert>
        : data.appliedAt ? <Alert variant="success" title="Database policy applied">Last applied {new Date(data.appliedAt).toLocaleString()}. Existing database sessions reconnect when a policy changes.</Alert>
        : <Alert variant="info" title="Default policy: allow all addresses">Database connections are allowed from any reachable address until you choose a more restrictive policy.</Alert>}

      <Card className="p-4 sm:p-5">
        <form onSubmit={savePolicy} className="flex flex-col gap-4">
          <div><label htmlFor="database-network-mode" className="text-sm font-semibold text-ink">Database connections</label>
            <select id="database-network-mode" className={INPUT} value={mode} disabled={!canWrite || busy}
              onChange={(event) => { setMode(event.target.value as NetworkAccessPolicy["mode"]); setValidationError(null); }}>
              <option value="restricted">Allow selected addresses</option>
              <option value="blocked">Block all database connections</option>
              <option value="all">Allow all addresses</option>
            </select></div>
          {mode === "restricted" && <div>
            <label htmlFor="database-network-ranges" className="text-sm font-semibold text-ink">Allowed IP addresses or ranges</label>
            <textarea id="database-network-ranges" className={`${INPUT} min-h-32 font-mono`} value={ranges}
              onChange={(event) => setRanges(event.target.value)} disabled={!canWrite || busy} spellCheck={false}
              aria-invalid={!!validationError} aria-describedby="database-network-help database-network-error"
              placeholder={"192.0.2.10\n198.51.100.0/24"} />
            <p id="database-network-help" className="mt-2 text-sm leading-5 text-neutral-600">One address or CIDR range per line. Use each client&apos;s public outbound IP. Every address outside this list is denied; remove an address to revoke access.</p>
          </div>}
          {mode === "all" && <Alert variant="warning">Any reachable address can attempt a database connection. Database credentials and the instance&apos;s SSL policy still apply.</Alert>}
          {mode === "blocked" && <Alert variant="info">External database clients will be disconnected and cannot reconnect. Supabase API and Studio continue to work.</Alert>}
          <p id="database-network-error" role={validationError ? "alert" : undefined} className="text-sm text-danger">{validationError}</p>
          {save.isError && <Alert variant="danger" title="Could not save network access">{save.error.message}</Alert>}
          {canWrite && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-4">
            <p className="max-w-[380px] text-xs leading-5 text-neutral-600">Saving reconnects this database&apos;s clients so the new policy takes effect. Other databases keep their policies.</p>
            <Button type="submit" variant="primary" disabled={busy || (!changed && !!data.appliedAt && !data.applyError)}>
              {save.isPending ? "Applying…" : !changed && data.applyError ? "Retry apply" : "Save and apply"}
            </Button></div>}
        </form>
      </Card>

      {!data.server.firewallManaged ? <Card className="p-4 sm:p-5">
        <h3 className="text-base font-semibold text-ink">Set up network access on {data.server.name}</h3>
        <p className="mt-2 text-sm leading-6 text-neutral-600">This server still uses its existing host firewall. It may block addresses even when a database allows them. One-time setup enables WHARF to apply each database&apos;s choices through the shared connection service.</p>
        <p className="mt-2 text-sm leading-6 text-neutral-600">Leave the baseline blank to keep every database open to reachable addresses. Enter addresses only when you want legacy databases to start restricted. Explicit policies already saved above are kept. Existing host rules are retained; WHARF adds its own rule for the shared database connection service, and that rule is evaluated first for its traffic.</p>
        {data.server.unconfiguredInstances.length > 0 ? <div className="mt-3 rounded-md bg-neutral-50 p-3 text-sm">
          <p className="font-semibold">Databases that will inherit these addresses</p>
          <ul className="mt-2 list-inside list-disc break-words">{data.server.unconfiguredInstances.map((row) => <li key={row.id}>{row.name}</li>)}</ul>
        </div> : <p className="mt-3 text-sm text-neutral-600">Every existing database already has an explicit policy. Leave the baseline blank to keep the default Allow all policy.</p>}
        {canWrite && <form className="mt-4 flex flex-col gap-4" onSubmit={setupServer}>
          <div><label htmlFor="network-baseline" className="text-sm font-semibold text-ink">Existing allowed addresses</label>
            <textarea id="network-baseline" className={`${INPUT} min-h-24 font-mono`} value={baseline}
              onChange={(event) => setBaseline(event.target.value)} disabled={busy} spellCheck={false}
              placeholder="Leave blank to allow all addresses" aria-describedby="network-baseline-help" />
            <p id="network-baseline-help" className="mt-2 text-sm text-neutral-600">Optional: one address or CIDR range per line for legacy databases. Include every application server that should retain access, including WHARF&apos;s panel server if its own database is hosted here. Setup can reconnect database clients.</p></div>
          <div><label htmlFor="network-server-confirm" className="text-sm font-semibold text-ink">Type {data.server.name} to confirm server setup</label>
            <input id="network-server-confirm" className={INPUT} value={confirmName} disabled={busy} autoComplete="off"
              onChange={(event) => setConfirmName(event.target.value)} /></div>
          {(setupError || setup.isError) && <Alert variant="danger" title="Server setup incomplete">{setupError || setup.error?.message}</Alert>}
          <div className="flex justify-end"><Button type="submit" variant="secondary" disabled={busy || confirmName !== data.server.name}>
            {setup.isPending ? "Setting up server…" : "Enable server network access"}
          </Button></div>
        </form>}
      </Card> : <Alert variant="info" title="WHARF manages the database firewall on this server">Each database has its own policy. Rules are restored after server restarts and container changes.</Alert>}
      <p className="text-xs leading-5 text-neutral-600">A cloud-provider firewall or a client network can still block connections before they reach WHARF. IPv6 requires a network path that preserves the client&apos;s address.</p>
    </div>
  );
}
