"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { MatchesScreen } from "../../../features/admin/matches-screen";

/** Jogos e pendências (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Jogos e pendências">
      <MatchesScreen admin={admin} />
    </AdminShell>
  );
}
