"use client";

import { CorrectionScreen } from "../../../../features/admin/payouts/correction/screen";
import { AdminShell, useAdminApi } from "../../../../features/admin/shell";

/** Correção de pagamentos depois do resultado mudar (admin). */
export default function Page() {
  const admin = useAdminApi();
  return (
    <AdminShell title="Correção de pagamentos">
      <CorrectionScreen admin={admin} />
    </AdminShell>
  );
}
