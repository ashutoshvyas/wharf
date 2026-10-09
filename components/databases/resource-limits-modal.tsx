"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import {
  CPU_LIMIT_MAX,
  CPU_LIMIT_MIN,
  MEMORY_LIMIT_MAX_MB,
  MEMORY_LIMIT_MIN_MB,
  formatResourceLimits,
  type ResourceLimits,
} from "@/lib/instances/resource-limits";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  ApiError,
  INSTANCES_QUERY_KEY,
  updateResourceLimits,
  type InstanceDto,
} from "./api";

const INPUT_CLASSES =
  "min-h-11 w-full rounded-[6px] border border-neutral-200 bg-white px-3 py-2 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 disabled:opacity-50 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

/** Empty input = unlimited; otherwise a number, or NaN when unparseable. */
function parseField(raw: string): number | null {
  return raw.trim() === "" ? null : Number(raw);
}

function validate(cpu: number | null, memGb: number | null): string | null {
  if (cpu !== null && (!Number.isFinite(cpu) || cpu < CPU_LIMIT_MIN || cpu > CPU_LIMIT_MAX)) {
    return `CPU must be between ${CPU_LIMIT_MIN} and ${CPU_LIMIT_MAX} cores, or empty for unlimited.`;
  }
  if (memGb !== null) {
    const mb = memGb * 1024;
    if (!Number.isFinite(mb) || mb < MEMORY_LIMIT_MIN_MB || mb > MEMORY_LIMIT_MAX_MB) {
      return `Memory must be between ${MEMORY_LIMIT_MIN_MB / 1024} and ${MEMORY_LIMIT_MAX_MB / 1024} GB, or empty for unlimited.`;
    }
  }
  return null;
}

export function ResourceLimitsModal({
  open,
  onClose,
  instance,
}: {
  open: boolean;
  onClose: () => void;
  instance: InstanceDto | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [cpu, setCpu] = useState("");
  const [memGb, setMemGb] = useState("");
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open || !instance) return;
    setCpu(instance.cpuLimit === null ? "" : String(instance.cpuLimit));
    setMemGb(instance.memoryLimitMb === null ? "" : String(instance.memoryLimitMb / 1024));
    setError(null);
  }, [open, instance]);

  const update = useMutation({
    mutationFn: (limits: ResourceLimits) => updateResourceLimits(instance!.id, limits),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["db-instance", updated.id] });
      toast({
        title: "Resource limits applied",
        message: updated.recreated
          ? `${updated.name} was restarted inside its own budget: ${formatResourceLimits(updated)}.`
          : `${updated.name} now runs within ${formatResourceLimits(updated)}.`,
        variant: "success",
      });
      onClose();
    },
    onError: (err: Error) => {
      // A failed apply still saves the budget (with the reason) — refresh it.
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      setError(err);
    },
  });

  if (!instance) return null;

  const cpuValue = parseField(cpu);
  const memValue = parseField(memGb);
  const invalid = validate(cpuValue, memValue);
  const limits: ResourceLimits = {
    cpuLimit: cpuValue,
    memoryLimitMb: memValue === null ? null : Math.round(memValue * 1024),
  };
  const neverApplied = instance.resourceLimitsAppliedAt === null;
  const changed =
    neverApplied ||
    limits.cpuLimit !== instance.cpuLimit ||
    limits.memoryLimitMb !== instance.memoryLimitMb;
  const close = () => {
    if (!update.isPending) onClose();
  };

  const title = `Resource limits — ${instance.name}`;
  return (
    <Dialog open={open} onClose={close} ariaLabel={title}>
      <ModalHead title={title} onClose={close} />
      <ModalBody>
        <p className="mb-4 text-[13px] leading-5 text-neutral-500">
          A budget for the whole instance — every container shares it, so one busy
          instance cannot starve the others on its server. Leave a field empty for no limit.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="instance-cpu-limit" className="label-track mb-1.5 block text-neutral-500">
              CPU (cores)
            </label>
            <input
              id="instance-cpu-limit"
              type="number"
              inputMode="decimal"
              min={CPU_LIMIT_MIN}
              max={CPU_LIMIT_MAX}
              step={0.25}
              placeholder="Unlimited"
              value={cpu}
              onChange={(e) => { setCpu(e.target.value); setError(null); }}
              disabled={update.isPending}
              className={INPUT_CLASSES}
            />
          </div>
          <div>
            <label htmlFor="instance-memory-limit" className="label-track mb-1.5 block text-neutral-500">
              Memory (GB)
            </label>
            <input
              id="instance-memory-limit"
              type="number"
              inputMode="decimal"
              min={MEMORY_LIMIT_MIN_MB / 1024}
              max={MEMORY_LIMIT_MAX_MB / 1024}
              step={0.5}
              placeholder="Unlimited"
              value={memGb}
              onChange={(e) => { setMemGb(e.target.value); setError(null); }}
              disabled={update.isPending}
              className={INPUT_CLASSES}
            />
          </div>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-neutral-500">
          {neverApplied
            ? "Not applied yet — this instance currently runs without a budget."
            : `Applied: ${formatResourceLimits(instance)}.`}{" "}
          Above 90% of the memory limit the instance is slowed down to reclaim memory; at the
          limit the kernel stops its largest process.
        </p>

        {instance.resourceLimitsError ? (
          <Alert variant="warning" className="mt-4" title="Last apply failed">
            {instance.resourceLimitsError}
          </Alert>
        ) : null}

        {neverApplied && instance.status === "running" ? (
          <Alert
            variant="info"
            icon={<Gauge size={17} strokeWidth={1.75} aria-hidden />}
            className="mt-4"
            title="First apply may restart this instance"
          >
            If this instance was created before per-instance limits, its containers are
            recreated inside the budget once — about a minute of downtime. Later changes
            apply live, with no restart.
          </Alert>
        ) : null}

        {invalid && (cpu !== "" || memGb !== "") ? (
          <p className="mt-3 text-xs text-danger">{invalid}</p>
        ) : null}

        {error ? (
          <Alert
            variant="danger"
            className="mt-4"
            title={
              error instanceof ApiError && error.status === 409
                ? "Cannot apply right now"
                : "Could not apply resource limits"
            }
          >
            {error.message}
          </Alert>
        ) : null}
      </ModalBody>
      <ModalFoot>
        <Button variant="secondary" onClick={close} disabled={update.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!changed || invalid !== null || update.isPending}
          onClick={() => update.mutate(limits)}
        >
          {update.isPending ? "Applying…" : "Apply limits"}
        </Button>
      </ModalFoot>
    </Dialog>
  );
}
