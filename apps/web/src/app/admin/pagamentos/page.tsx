"use client";

import { PayoutsScreen } from "../../../features/admin/payouts/screen";
import { AdminShell, useAdminApi } from "../../../features/admin/shell";

/** Pagamentos aguardando, prévia e aprovação (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Pagamentos de dividendos">
      <PayoutsScreen admin={admin} />
    </AdminShell>
  );
}
