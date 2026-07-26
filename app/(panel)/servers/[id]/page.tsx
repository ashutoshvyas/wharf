/**
 * /servers/[id] — server wrapper. Next 15: params is a Promise.
 * Resolves the id + session role on the server and hands both to the client
 * detail view (Overview / Hosted / Terminal tabs, ?tab= synced).
 */
import { auth } from "@/lib/auth";
import { ServerDetail } from "@/components/servers/server-detail";
import type { Role } from "@/lib/rbac";

export default async function ServerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const role = (session?.user?.role ?? "viewer") as Role;
  return <ServerDetail id={id} role={role} />;
}
