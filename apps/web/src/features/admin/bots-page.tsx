"use client";

import type { AdminApi } from "./api";
import { BotsScreen } from "./bots-screen";
import { LoadState, useLoader } from "./ui";

/** Acha a temporada atual (a chave dos bots é dela) e mostra a tela dos bots. */
export function BotsPage({ admin }: { admin: AdminApi }) {
  const season = useLoader(() => admin.currentSeason());
  if (!season.data) return <LoadState loader={season} />;
  return <BotsScreen admin={admin} seasonId={season.data.season?.id ?? null} />;
}
