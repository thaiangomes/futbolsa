"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { SuspensionScreen } from "../../../features/admin/suspension-screen";

/** Suspensão da negociação (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Suspensão da negociação">
      <SuspensionScreen admin={admin} />
    </AdminShell>
  );
}
