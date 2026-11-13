import { buybackEvents, type PayoutEvent } from "@futbolsa/engine";
import { DIVIDEND_EVENTS, eventsResultOf, type PayoutEventSource } from "./close-events.service.js";
import type { SeasonEngineInput } from "./engine-input.js";

/** Como o motivo da recompra chama o último evento da temporada. */
const LAST_EVENT: Record<string, string> = {
  "brasileirao-a": "último jogo da Série A",
  "brasileirao-b": "último jogo da Série B",
  "copa-do-brasil": "final da Copa do Brasil",
  libertadores: "final da Libertadores",
  sulamericana: "final da Sul-Americana",
};

const BRASILIA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "18h de 19/12/2027" (ou "18h05 de …"), no horário de Brasília. */
function brasiliaText(ms: number): string {
  const parts = Object.fromEntries(BRASILIA.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const time = parts.minute === "00" ? `${parts.hour}h` : `${parts.hour}h${parts.minute}`;
  return `${time} de ${parts.day}/${parts.month}/${parts.year}`;
}

/**
 * O apito final do último evento da temporada (o maior fechamento por competição de `eventsFor`), para o motivo do
 * evento de recompra (decisão 1 do Plano do encerramento e da recompra): "final da Copa do Brasil às 18h de 19/12/2027".
 * `undefined` se alguma competição ainda está aberta.
 */
export function lastWhistle(closes: Readonly<Record<string, number | undefined>>): string | undefined {
  const entries = Object.entries(closes);
  if (entries.length === 0 || entries.some(([, v]) => v === undefined)) return undefined;
  const [competition, at] = entries.reduce((best, entry) => (entry[1]! > best[1]! ? entry : best));
  return `${LAST_EVENT[competition] ?? competition} às ${brasiliaText(at!)}`;
}

/**
 * Os eventos de recompra da temporada no instante `closedAt` (D, o `trading_ended_at`): um por clube listado, inclusive
 * R$ 0,00, pelo `buybackEvents` do motor sobre os dividendos que os resultados de agora dão (`eventsFor`, sem a
 * recompra), com o motivo trazendo o apito final.
 *
 * Por que os resultados de agora, e não as linhas gravadas: é o mesmo cálculo no fechamento (T3), na prévia refeita
 * pela passada (antes da aprovação) e no plano da correção (depois dela). Corrigido um resultado, os dividendos "depois"
 * e a recompra "depois" saem da mesma conta, então a correção do dividendo e a da recompra entram juntas no mesmo plano;
 * sem correção pendente, os dividendos de agora são os das versões vigentes. Dividendo que fecharia depois de D (um
 * horário de jogo corrigido para depois do fim da negociação) não entra: a recompra já fechou.
 */
export function buybackEventsOf(loaded: SeasonEngineInput, closedAt: number): PayoutEvent[] {
  const own = new Set<string>(DIVIDEND_EVENTS.kinds);
  const dividends = DIVIDEND_EVENTS.events(loaded).filter((e) => own.has(e.kind) && e.closedAt <= closedAt);
  const whistle = lastWhistle(eventsResultOf(loaded).closes);
  return buybackEvents(dividends, loaded.input.listed, loaded.buybackMultipleBp, closedAt).map((event) => ({
    ...event,
    reason: whistle ? `recompra, fim da temporada: ${whistle} (${event.reason.replace(/^recompra: /, "")})` : event.reason,
  }));
}

/**
 * A fonte da recompra na passada de fechamento e no plano da correção (T5): só com a negociação encerrada. Antes da
 * aprovação, a passada refaz a prévia (versão nova `pending`, com a foto de D copiada, porque D não muda); depois, o
 * plano da correção compara a versão aprovada com esta.
 */
export const BUYBACK_EVENTS: PayoutEventSource = {
  name: "recompra",
  kinds: ["buyback"],
  active: (loaded) => loaded.tradingEndedAt !== null,
  events: (loaded) => (loaded.tradingEndedAt === null ? [] : buybackEventsOf(loaded, loaded.tradingEndedAt.getTime())),
};
