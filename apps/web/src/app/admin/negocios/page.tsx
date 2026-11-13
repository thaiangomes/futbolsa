"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { AuditScreen } from "../../../features/admin/audit-screen";

/** Auditoria de negócios (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Auditoria de negócios">
      <AuditScreen admin={admin} />
    </AdminShell>
  );
}
