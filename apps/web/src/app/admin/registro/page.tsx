"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { LogScreen } from "../../../features/admin/log-screen";

/** Registro do admin (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Registro do admin">
      <LogScreen admin={admin} />
    </AdminShell>
  );
}
