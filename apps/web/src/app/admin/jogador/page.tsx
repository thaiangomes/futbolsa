"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AdminShell, useAdminApi } from "../../../features/admin/shell";
import { PlayerDetailScreen } from "../../../features/admin/players-screen";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Detail() {
  const admin = useAdminApi();
  const id = useSearchParams().get("id") ?? "";
  if (!UUID.test(id)) return <p className="muted">Jogador não encontrado. <a href="/admin/jogadores">Ver os jogadores</a></p>;
  return <PlayerDetailScreen admin={admin} id={id} />;
}

/** Um jogador (admin): o id vem no endereço (`/admin/jogador?id=…`), porque o site é estático. */
export default function Page() {
  return (
    <AdminShell title="Jogador">
      <Suspense fallback={<p className="muted">Carregando…</p>}>
        <Detail />
      </Suspense>
    </AdminShell>
  );
}
