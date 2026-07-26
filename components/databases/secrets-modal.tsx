"use client";

/**
 * Connection & secrets (design §5.6 overflow menu, contract §3 `/secrets`).
 *
 * The endpoint is audited and `no-store`, so it is hit lazily — only when the
 * operator actually reveals or copies a masked field. One in-flight promise is
 * shared by all three secret fields so a single reveal doesn't cause three
 * audit entries; the public URLs come straight from the DTO and cost nothing.
 */
import { useEffect, useRef } from "react";
import { KeyRound } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { MonoField } from "@/components/ui/mono-field";
import {
  fetchInstanceSecrets,
  type InstanceDto,
  type InstanceSecretsDto,
} from "./api";

export function SecretsModal({
  open,
  onClose,
  instance,
}: {
  open: boolean;
  onClose: () => void;
  instance: InstanceDto | null;
}) {
  const pending = useRef<Promise<InstanceSecretsDto> | null>(null);
  const id = instance?.id ?? null;

  // Never carry a fetched payload across instances or across openings.
  useEffect(() => {
    pending.current = null;
  }, [id, open]);

  function load(): Promise<InstanceSecretsDto> {
    if (!id) return Promise.reject(new Error("No instance selected."));
    pending.current ??= fetchInstanceSecrets(id).catch((err: unknown) => {
      pending.current = null; // let the next reveal retry
      throw err;
    });
    return pending.current;
  }

  if (!instance) return null;

  return (
    <Dialog open={open} onClose={onClose} wide>
      <ModalHead title={`Connection & secrets — ${instance.name}`} onClose={onClose} />
      <ModalBody className="flex flex-col gap-3">
        <MonoField
          key={`${instance.id}-api`}
          label="API URL (Kong — public)"
          value={`https://${instance.apiSubdomain}`}
        />
        <MonoField
          key={`${instance.id}-studio`}
          label="Studio URL (panel-gated)"
          value={`https://${instance.studioSubdomain}`}
        />
        <MonoField
          key={`${instance.id}-anon`}
          label="anon key"
          secret
          onReveal={async () => (await load()).anonKey}
        />
        <MonoField
          key={`${instance.id}-service`}
          label="service_role key — never ship to a browser"
          secret
          onReveal={async () => (await load()).serviceRoleKey}
        />
        <MonoField
          key={`${instance.id}-pg`}
          label="Postgres password"
          secret
          onReveal={async () => (await load()).pgPassword}
        />
        <Alert
          variant="info"
          icon={<KeyRound size={17} strokeWidth={1.75} />}
          title="Every reveal is audited."
        >
          Secrets are stored AES-256-GCM encrypted and decrypted in-memory per
          request. Revealed values re-mask after 30 seconds.
        </Alert>
      </ModalBody>
      <ModalFoot>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFoot>
    </Dialog>
  );
}
