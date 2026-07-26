/**
 * /databases/[id]/manage — Studio SSO view.
 *
 * Server component: resolves the instance and enforces the two preconditions
 * (the instance must exist and be running; the viewer role cannot reach
 * Studio, which is a mutating surface — the same rule /api/auth/verify
 * applies at the proxy). Rendering is delegated to the client ManageView,
 * which owns the iframe and its frame-blocking fallback.
 */
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, type Role } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { serializeInstance } from "@/lib/instances/serialize";
import { ManageView } from "@/components/databases/manage-view";
import type { InstanceDto } from "@/components/databases/api";

export default async function ManagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const role = (session?.user?.role ?? "viewer") as Role;
  if (!can(role, "secrets.reveal")) redirect("/databases");

  const { id } = await params;
  const row = await prisma.dbInstance.findUnique({ where: { id } });
  if (!row || row.deletedAt) notFound();
  // Studio only exists while the stack is up.
  if (row.status !== "running") redirect("/databases");

  // serializeInstance types `status` as string (it mirrors the DB column);
  // the client DTO narrows it to the InstanceStatus union. The redirect above
  // already guarantees this row is "running".
  const instance = serializeInstance(row) as unknown as InstanceDto;
  return <ManageView instance={instance} role={role} />;
}
