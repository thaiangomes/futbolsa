"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { StandingsScreen } from "../../../features/admin/standings-screen";

/** Classificação oficial (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Classificação oficial">
      <StandingsScreen admin={admin} />
    </AdminShell>
  );
}
