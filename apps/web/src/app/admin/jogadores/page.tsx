"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { PlayersScreen } from "../../../features/admin/players-screen";

/** Jogadores (admin): lista com busca. */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Jogadores">
      <PlayersScreen admin={admin} />
    </AdminShell>
  );
}
