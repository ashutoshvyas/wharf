/**
 * /websites — server wrapper. Reads the session role once on the
 * server and hands it to the client view, which mirrors the RBAC matrix via
 * can() to hide write actions (design §6).
 */
import { auth } from "@/lib/auth";
import { WebsitesView } from "@/components/websites/websites-view";
import type { Role } from "@/lib/rbac";

export default async function WebsitesPage() {
  const session = await auth();
  const role = (session?.user?.role ?? "viewer") as Role;
  return <WebsitesView role={role} />;
}
