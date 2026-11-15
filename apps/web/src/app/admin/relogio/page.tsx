"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { RelogioScreen } from "../../../features/admin/partida/relogio-screen";

/** O relógio da partida de teste (só no modo partida). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Relógio da partida">
      <RelogioScreen admin={admin} />
    </AdminShell>
  );
}
