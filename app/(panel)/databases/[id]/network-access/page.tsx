import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, type Role } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { serializeInstance } from "@/lib/instances/serialize";
import { NetworkAccessForm } from "@/components/databases/network-access-form";
import type { InstanceDto } from "@/components/databases/api";

/** Also available for stopped/errored instances and read-only viewers. */
export default async function NetworkAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const role = (session?.user?.role ?? "viewer") as Role;
  if (!session || !can(role, "instances.read")) redirect("/login");
  const row = await prisma.dbInstance.findFirst({ where: { id: (await params).id, deletedAt: null } });
  if (!row) notFound();
  return <div>
    <Link href="/databases" className="inline-flex min-h-11 items-center text-sm font-semibold text-cobalt-600 hover:underline">← Databases</Link>
    <NetworkAccessForm instance={serializeInstance(row) as InstanceDto} role={role} />
  </div>;
}
