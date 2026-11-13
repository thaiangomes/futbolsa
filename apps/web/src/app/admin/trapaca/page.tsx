"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { FraudCaseScreen, FraudCasesScreen } from "../../../features/admin/fraud-screen";

function Content() {
  const admin = useAdminApi();
  const raw = useSearchParams().get("id");
  if (raw === null) return <FraudCasesScreen admin={admin} />;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) return <p className="muted">Caso não encontrado. <a href="/admin/trapaca">Ver os casos</a></p>;
  return <FraudCaseScreen admin={admin} id={id} />;
}

/** Trapaça entre contas (admin): a lista de casos e, com `?id=`, o relatório e a decisão (o site é estático). */
export default function Page() {
  return (
    <AdminShell title="Trapaça entre contas">
      <Suspense fallback={<p className="muted">Carregando…</p>}>
        <Content />
      </Suspense>
    </AdminShell>
  );
}
