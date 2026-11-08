"use client";

import { AdminShell, useAdminApi } from "../../features/admin/shell";
import { OverviewScreen } from "../../features/admin/overview-screen";

/** Visão geral do admin: o que pede atenção. */
export default function AdminHomePage() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Admin">
      <OverviewScreen admin={admin} />
    </AdminShell>
  );
}
