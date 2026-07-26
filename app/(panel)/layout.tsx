import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { PanelShell } from "@/components/shell/panel-shell";
import { Providers } from "@/components/providers";
import type { Role } from "@/lib/rbac";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <Providers>
      <PanelShell
        user={{
          email: session.user.email,
          role: (session.user.role ?? "viewer") as Role,
        }}
        signOutAction={signOutAction}
      >
        {children}
      </PanelShell>
    </Providers>
  );
}
