"use client";

import { AdminShell, useAdminApi } from "../../../../features/admin/shell";
import { SeasonCloseScreen } from "../../../../features/admin/season-close-screen";

/** Encerrar a temporada (admin): a lista do que falta, o resumo e a confirmação digitando o ano. */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Encerrar a temporada">
      <SeasonCloseScreen admin={admin} />
    </AdminShell>
  );
}
