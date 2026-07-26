/**
 * /audit — server wrapper. The audit log is readable by every role
 * (`audit.read` = all), so unlike the other modules there is no role to
 * thread through: the client view mounts unconditionally.
 */
import { AuditView } from "@/components/audit/audit-view";

export default function AuditPage() {
  return <AuditView />;
}
