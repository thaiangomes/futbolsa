"use client";

import { MarketMakerScreen } from "../../../features/admin/market-maker/screen";
import { AdminShell, useAdminApi } from "../../../features/admin/shell";

/** Percentuais do formador de mercado (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Formador de mercado">
      <MarketMakerScreen admin={admin} />
    </AdminShell>
  );
}
