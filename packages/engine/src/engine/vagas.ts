/**
 * Vagas para a Libertadores e a Sul-Americana do ano seguinte, com a cascata (especificação "Vagas e copas no valor justo dos
 * bots"). O admin descreve as regras da temporada (`SlotRules`); este módulo só as aplica, sem saber nada da CBF nem da Conmebol.
 * Serve ao valor justo dos bots (um cenário simulado de cada vez); o pagamento usa sempre a marcação do admin.
 *
 * Ordem da cascata:
 * 1. as rotas pelas copas ocupam vagas primeiro, destino mais forte antes (a ordem de `destinations`);
 * 2. o dono da rota que está rebaixado, ou que já tem vaga, devolve a vaga: ela passa para a tabela do mesmo destino;
 * 3. as vagas da tabela (as fixas mais as devolvidas) vão, na ordem da classificação final, a quem ainda não tem vaga e não caiu.
 * Dono de rota que não é da Série A (campeão estrangeiro, clube da Série B) ocupa a vaga fora da tabela e não mexe nela.
 */

export type SlotDestination = "libertadores" | "sulamericana";

export interface SlotRoute {
  /** A competição, como nas regras da temporada: "copa-do-brasil", "libertadores", "sulamericana". */
  cup: string;
  /** Quem ganha a vaga: o campeão ou o vice-campeão (o outro finalista). */
  result: "champion" | "runnerUp";
}

export interface SlotRuleOfDestination {
  destination: SlotDestination;
  /** Vagas da tabela de classificação (1º, 2º...), sem contar as rotas. */
  tableSlots: number;
  routes: SlotRoute[];
}

/** As regras de vaga da temporada, do destino mais forte para o mais fraco. */
export interface SlotRules {
  destinations: SlotRuleOfDestination[];
}

/** Sem regras montadas pelo admin: as vagas da tabela que os bots usavam, sem rotas (Libertadores 6, Sul-Americana 6). */
export const DEFAULT_SLOT_RULES: SlotRules = {
  destinations: [
    { destination: "libertadores", tableSlots: 6, routes: [] },
    { destination: "sulamericana", tableSlots: 6, routes: [] },
  ],
};

/** Quem foi campeão e quem foi vice de uma copa, num cenário. */
export interface CupFinal {
  champion?: string;
  runnerUp?: string;
}

/**
 * Quem vai para onde. `table` é a classificação final da Série A, do 1º ao último; `relegated` são os rebaixados; `cups` dá o
 * resultado de cada copa pela chave da rota. Devolve só os clubes classificados (clube que não aparece não tem vaga).
 */
export function resolveSlots(
  rules: SlotRules,
  table: readonly string[],
  relegated: ReadonlySet<string>,
  cups: Readonly<Record<string, CupFinal>>,
): Map<string, SlotDestination> {
  const inTable = new Set(table);
  const taken = new Map<string, SlotDestination>();
  const freed = new Map<SlotDestination, number>();

  for (const rule of rules.destinations) {
    for (const route of rule.routes) {
      const final = cups[route.cup];
      const owner = route.result === "champion" ? final?.champion : final?.runnerUp;
      if (owner === undefined || !inTable.has(owner)) continue; // sem dono da Série A: a vaga não mexe na tabela
      if (relegated.has(owner) || taken.has(owner)) {
        freed.set(rule.destination, (freed.get(rule.destination) ?? 0) + 1);
        continue;
      }
      taken.set(owner, rule.destination);
    }
  }

  for (const rule of rules.destinations) {
    let left = rule.tableSlots + (freed.get(rule.destination) ?? 0);
    for (const club of table) {
      if (left <= 0) break;
      if (relegated.has(club) || taken.has(club)) continue;
      taken.set(club, rule.destination);
      left--;
    }
  }
  return taken;
}
