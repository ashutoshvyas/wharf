"use client";

/**
 * Analytics buckets form — a single on/off toggle for Storage's
 * Analytics (Iceberg) buckets. Unlike Auth settings/Email templates, there's
 * nothing else to configure: MinIO and Lakekeeper's own secrets are all
 * derived server-side (lib/provision/secrets.ts's deriveAnalyticsSecrets),
 * never operator-supplied.
 *
 * Off by default — unlike Vector buckets (always on, effectively free),
 * enabling this starts two more containers per instance
 * (`profiles: ["analytics"]` in templates/supabase/docker-compose.yml).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { fetchAnalyticsSettings, updateAnalyticsSettings, type InstanceDto } from "./api";

export function AnalyticsSettingsForm({ instance, role }: { instance: InstanceDto; role: Role }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(role, "instance.auth-settings.write");
  const queryKey = ["analytics-settings", instance.id];

  const query = useQuery({
    queryKey,
    queryFn: () => fetchAnalyticsSettings(instance.id),
  });

  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (query.data) setEnabled(query.data.enabled);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (next: boolean) => updateAnalyticsSettings(instance.id, next),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey });
      setEnabled(result.enabled);
      toast({
        title: result.applied ? "Saved" : "Saved, but the change didn't apply",
        message: result.applied
          ? result.enabled
            ? `Analytics buckets enabled for ${instance.name} — MinIO and the Iceberg catalog are starting up.`
            : `Analytics buckets disabled for ${instance.name}.`
          : `The setting was saved, but applying it failed: ${result.applyError ?? "unknown error"}. Retry from here once the server issue clears.`,
        variant: result.applied ? "success" : "danger",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", message: err.message, variant: "danger" });
    },
  });

  if (query.isPending) {
    return (
      <div className="p-6">
        <Card className="p-5">
          <p className="text-[13px] text-neutral-500">Loading…</p>
        </Card>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="p-6">
        <Alert variant="danger" title="Could not load Analytics buckets settings">
          <p>{query.error.message}</p>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 p-6">
      {!canWrite ? (
        <Alert variant="info">
          Viewing only — changing this setting requires the admin role.
        </Alert>
      ) : null}

      <Card className="p-5">
        <div className="mb-4 flex items-start gap-2.5">
          <div className="mt-0.5 text-neutral-400">
            <Boxes size={18} strokeWidth={1.75} />
          </div>
          <div>
            <h3 className="text-[14.5px] font-semibold text-ink">Analytics buckets</h3>
            <p className="mt-0.5 text-[13px] text-neutral-500">
              Iceberg-backed Storage buckets for data-lake / large analytical workloads,
              self-hosted via MinIO (object storage) and a Lakekeeper Iceberg REST catalog —
              two extra containers per instance, so this is off by default.
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2.5 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canWrite || save.isPending}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded-[3px] border-neutral-300 text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 disabled:cursor-not-allowed"
          />
          Enable Analytics buckets for this instance
        </label>

        {canWrite ? (
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              variant="accent"
              disabled={save.isPending || enabled === query.data.enabled}
              onClick={() => save.mutate(enabled)}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
