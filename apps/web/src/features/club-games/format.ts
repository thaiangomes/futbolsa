import type { Fixture } from "@futbolsa/contracts";
import { CUP_NAMES, phaseName } from "../club-value/model";

const BRASILIA = "America/Sao_Paulo";

/** A data e a hora de Brasília de um jogo, no formato curto: `sáb. 18/04, 16h00`. */
export function formatKickoff(iso: string): string {
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: BRASILIA, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("weekday")} ${get("day")}/${get("month")}, ${hour}h${get("minute")}`;
}

/** Só a data e a hora, para a coluna do Mercado: `18/04 16h00`. */
export function formatKickoffShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: BRASILIA, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("day")}/${get("month")} ${hour}h${get("minute")}`;
}

/** O nome da competição como a tela fala. */
export function competitionName(competition: Fixture["competition"]): string {
  if (competition === "brasileirao-a") return "Brasileirão";
  if (competition === "brasileirao-b") return "Série B";
  return CUP_NAMES[competition] ?? competition;
}

/** A rodada ou a fase do jogo (`Rodada 12`, `Oitavas`), ou `null` quando a fonte não diz. */
export function stageText(fixture: Pick<Fixture, "round" | "phase">): string | null {
  if (fixture.round !== null) return `Rodada ${fixture.round}`;
  if (fixture.phase) {
    const name = phaseName(fixture.phase);
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return null;
}

/** O mando: em casa ou fora. */
export const venueText = (fixture: Pick<Fixture, "home">): string => (fixture.home ? "Em casa" : "Fora");
