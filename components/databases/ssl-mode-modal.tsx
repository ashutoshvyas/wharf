"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { InstanceSslMode } from "@/lib/instances/ssl-mode";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  ApiError,
  INSTANCES_QUERY_KEY,
  updateInstanceSslMode,
  type InstanceDto,
} from "./api";

const SELECT_CLASSES =
  "h-11 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

export function SslModeModal({
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
  const [sslMode, setSslMode] = useState<InstanceSslMode>("require");
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open || !instance) return;
    setSslMode(instance.sslMode);
    setError(null);
  }, [open, instance]);

  const update = useMutation({
    mutationFn: (mode: InstanceSslMode) => updateInstanceSslMode(instance!.id, mode),
    onSuccess: (updated) => {
      queryClient.setQueryData<InstanceDto[]>(INSTANCES_QUERY_KEY, (rows) =>
        rows?.map((row) => (row.id === updated.id ? updated : row)),
      );
      queryClient.setQueryData(["db-instance", updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["db-instance", updated.id] });
      toast({
        title: "SSL mode updated",
        message:
          updated.sslMode === "require"
            ? `${updated.name} now rejects plaintext pooler connections.`
            : `${updated.name} now accepts plaintext pooler connections.`,
        variant: updated.sslMode === "require" ? "success" : "warning",
      });
      onClose();
    },
    onError: (err: Error) => {
      setError(err);
    },
  });

  if (!instance) return null;
  const changed = sslMode !== instance.sslMode;
  const close = () => {
    if (!update.isPending) onClose();
  };

  return (
    <Dialog open={open} onClose={close}>
      <ModalHead title={`SSL mode — ${instance.name}`} onClose={close} />
      <ModalBody>
        <p className="mb-4 text-[13px] leading-5 text-neutral-500">
          This controls whether the instance&apos;s public session and transaction
          pooler endpoints accept plaintext PostgreSQL connections. Database
          containers and credentials are unchanged.
        </p>

        <label htmlFor="existing-instance-ssl-mode" className="label-track mb-1.5 block text-neutral-500">
          SSL mode
        </label>
        <select
          id="existing-instance-ssl-mode"
          value={sslMode}
          onChange={(event) => {
            setSslMode(event.target.value as InstanceSslMode);
            setError(null);
          }}
          aria-describedby="existing-instance-ssl-mode-help"
          disabled={update.isPending}
          className={SELECT_CLASSES}
        >
          <option value="require">Require TLS (recommended)</option>
          <option value="disable">Disable TLS enforcement</option>
        </select>
        <p
          id="existing-instance-ssl-mode-help"
          className="mt-1.5 text-xs leading-5 text-neutral-500"
        >
          Current mode: {instance.sslMode === "require" ? "Require TLS" : "Disabled"}.
        </p>

        {sslMode === "require" ? (
          <Alert
            variant="info"
            icon={<ShieldCheck size={17} strokeWidth={1.75} aria-hidden />}
            className="mt-4"
            title="TLS will be required"
          >
            Plaintext clients will be rejected and generated connection strings will use
            <code className="mx-1 font-mono text-[12px]">sslmode=require</code>.
            On an older server, the shared pooler may reconcile once to install its TLS listener.
          </Alert>
        ) : (
          <Alert variant="warning" className="mt-4" title="Plaintext connections will be accepted">
            Clients may connect without encryption, so database credentials and traffic can cross
            the network in plaintext. Use this only for legacy client compatibility.
          </Alert>
        )}

        {error ? (
          <Alert
            variant="danger"
            className="mt-4"
            title={
              error instanceof ApiError && error.status === 409
                ? "Server is busy"
                : "Could not update SSL mode"
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
          variant={sslMode === "disable" ? "danger" : "primary"}
          disabled={!changed || update.isPending}
          onClick={() => update.mutate(sslMode)}
        >
          {update.isPending
            ? "Applying…"
            : sslMode === "require"
              ? "Require TLS"
              : "Disable TLS enforcement"}
        </Button>
      </ModalFoot>
    </Dialog>
  );
}
