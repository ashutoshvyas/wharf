/**
 * /databases — server wrapper. Reads the session role once on the
 * server (the client view mirrors the RBAC matrix via can() to hide write
 * actions, design §6) and resolves INSTANCE_DOMAIN here so the subdomain
 * preview never needs a NEXT_PUBLIC_ variable.
 */
import { auth } from "@/lib/auth";
import { DatabasesView } from "@/components/databases/databases-view";
import type { Role } from "@/lib/rbac";

export default async function DatabasesPage() {
  const session = await auth();
  const role = (session?.user?.role ?? "viewer") as Role;
  const domain = process.env.INSTANCE_DOMAIN ?? "example.com";
  return <DatabasesView role={role} domain={domain} />;
}
