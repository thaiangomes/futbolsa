"use client";

import { useSyncExternalStore } from "react";
import type { ChartMarker } from "./markers";

/**
 * Quais marcadores o gráfico mostra (Carteira e gráficos, critérios 46 e 47): dividendos, minhas negociações e jogos, e
 * dos jogos, quais competições. A escolha é do jogador, vale para todos os clubes e para o gráfico de patrimônio da
 * Carteira (que só tem dividendos), e fica salva no navegador, por aparelho. Tudo ligado na primeira vez. Guardamos as
 * competições **desligadas** (e não as ligadas), para uma competição que aparece depois vir ligada.
 */
export interface MarkerPrefs {
  payout: boolean;
  trade: boolean;
  game: boolean;
  hiddenCompetitions: readonly string[];
}

export const DEFAULT_MARKER_PREFS: MarkerPrefs = { payout: true, trade: true, game: true, hiddenCompetitions: [] };

const KEY = "futbolsa.marcadores";

/** Lê o que está salvo; qualquer coisa que não seja o formato esperado vira o padrão (tudo ligado). */
export function parseMarkerPrefs(raw: string | null): MarkerPrefs {
  if (!raw) return DEFAULT_MARKER_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<MarkerPrefs> | null;
    if (!v || typeof v !== "object") return DEFAULT_MARKER_PREFS;
    return {
      payout: v.payout !== false,
      trade: v.trade !== false,
      game: v.game !== false,
      hiddenCompetitions: Array.isArray(v.hiddenCompetitions) ? v.hiddenCompetitions.filter((c): c is string => typeof c === "string") : [],
    };
  } catch {
    return DEFAULT_MARKER_PREFS;
  }
}

function readStored(): MarkerPrefs {
  try {
    return parseMarkerPrefs(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_MARKER_PREFS; // armazenamento bloqueado (janela privada, dados do site limpos): o gráfico funciona sem salvar
  }
}

let current: MarkerPrefs | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const snapshot = (): MarkerPrefs => (current ??= readStored());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // outra aba do mesmo navegador mudou a escolha
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = readStored();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** A escolha atual dos marcadores e como mudá-la; todos os gráficos da página andam juntos. */
export function useMarkerPrefs(): [MarkerPrefs, (patch: Partial<MarkerPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_MARKER_PREFS);
  return [prefs, setMarkerPrefs];
}

export function setMarkerPrefs(patch: Partial<MarkerPrefs>): void {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // sem armazenamento: vale só até recarregar
  }
  notify();
}

/** Só para os testes: volta ao padrão e esquece o que estava salvo. */
export function resetMarkerPrefs(): void {
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nada a limpar
  }
  notify();
}

/** Tira do gráfico o que o jogador desligou. */
export function filterMarkers(markers: readonly ChartMarker[], prefs: MarkerPrefs): ChartMarker[] {
  return markers.filter((m) => {
    if (m.kind === "payout") return prefs.payout;
    if (m.kind === "trade") return prefs.trade;
    return prefs.game && !(m.competition !== undefined && prefs.hiddenCompetitions.includes(m.competition));
  });
}
