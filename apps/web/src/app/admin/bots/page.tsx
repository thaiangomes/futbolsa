"use client";

import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { BotsPage } from "../../../features/admin/bots-page";

/** Bots ao vivo (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Bots">
      <BotsPage admin={admin} />
    </AdminShell>
  );
}
// teste do CI
