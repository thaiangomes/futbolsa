"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { SeasonScreen } from "../../../features/admin/season-screen";

/** Preparar a temporada (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Preparar a temporada">
      <SeasonScreen admin={admin} />
    </AdminShell>
  );
}
