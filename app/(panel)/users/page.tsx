/**
 * /users — server wrapper. Admin-only screen: non-admins are
 * redirected to /databases rather than shown a locked panel (design §6 hides
 * what a role cannot do). The API enforces the same gate independently.
 *
 * The signed-in email is read here and handed down so the view can mark the
 * "you" row and hide its own action menu without a client-side session fetch.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, type Role } from "@/lib/rbac";
import { UsersView } from "@/components/users/users-view";

export default async function UsersPage() {
  const session = await auth();
  if (!can(session?.user?.role as Role | undefined, "users")) {
    redirect("/databases");
  }
  return <UsersView currentUserEmail={session?.user?.email ?? ""} />;
}
