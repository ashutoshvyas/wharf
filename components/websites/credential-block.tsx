"use client";

/**
 * Row-expansion content for the Websites table (, design §5.5):
 * credential MonoFields (username plain, password masked with audited
 * async reveal) + notes.
 *
 * The credential is fetched from GET /api/websites/:id/credential when the
 * block mounts (i.e. when the row is expanded) for operator+ roles — that
 * call is the audited reveal. The password field's onReveal resolves through
 * the same 30s-fresh query cache, re-hitting (and re-auditing) the endpoint
 * once the cache has expired. Viewers never trigger the fetch.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { MonoField } from "@/components/ui/mono-field";
import { fetchWebsiteCredential, type WebsiteDto } from "./api";

const CREDENTIAL_STALE_MS = 30_000;

export function CredentialBlock({
  website,
  canReveal,
}: {
  website: WebsiteDto;
  canReveal: boolean;
}) {
  const queryClient = useQueryClient();
  const queryOptions = {
    queryKey: ["website-credential", website.id],
    queryFn: () => fetchWebsiteCredential(website.id),
    staleTime: CREDENTIAL_STALE_MS,
    gcTime: CREDENTIAL_STALE_MS,
    retry: false,
  };
  const credential = useQuery({
    ...queryOptions,
    enabled: canReveal && website.hasCredential,
  });

  return (
    <div className="max-w-[760px]">
      {!website.hasCredential ? (
        <p className="text-[13px] text-neutral-500">
          No credential stored for this website.
        </p>
      ) : !canReveal ? (
        <p className="text-[13px] text-neutral-500">
          Credentials are hidden for your role — reveal requires operator
          access.
        </p>
      ) : credential.isError ? (
        <Alert variant="danger">Could not load the credential.</Alert>
      ) : credential.isPending ? (
        <p className="text-[13px] text-neutral-500">Loading credential…</p>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <MonoField
            label={`${website.credentialLabel} · username`}
            value={credential.data.username ?? "—"}
          />
          <MonoField
            label={`${website.credentialLabel} · password`}
            secret
            onReveal={async () =>
              (await queryClient.fetchQuery(queryOptions)).password
            }
          />
        </div>
      )}
      {website.notes ? (
        <div className="mt-3.5">
          <div className="label-track text-neutral-500">Notes</div>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] text-neutral-600">
            {website.notes}
          </p>
        </div>
      ) : null}
    </div>
  );
}
