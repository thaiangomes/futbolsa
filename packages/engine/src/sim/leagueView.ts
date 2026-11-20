import type { CupRules, LeagueRules, StandingRow } from "../engine/dividends.js";
import {
  cupExpected,
  cupStage,
  fairValue,
  fairValueWithPpg,
  pointsPerGame,
  prepareCups,
  projectLeague,
  type FairValueInput,
  type LeagueProjection,
  type PreparedCup,
} from "../engine/fairValue.js";
import { livePointsDelta, type LiveMatch } from "../engine/liveScore.js";
import type { Cents } from "../engine/money.js";
import { finishTime, kickoffTime, type Match } from "../engine/types.js";

/**
 * O que se sabe de um campeonato num instante: a tabela dos jogos já encerrados, o valor justo de cada clube
 * (dividendos que ainda devem vir na temporada), os próximos jogos e a vantagem em cada um. Sem preço, sem ordens e sem
 * carteiras: é a parte dos bots que não depende de quem negocia. A simulação (`MarketView`) acrescenta o mercado
 * simulado; a API ao vivo (F14, `LiveBotView`) acrescenta o mercado do banco. As duas calculam o valor justo, a
 * colocação e a vantagem pelas mesmas funções do motor, por esta classe.
 */
export class LeagueView {
  now = 0;
  protected known: Match[] = [];
  protected projection!: LeagueProjection;
  /** Pontos já pagos em dividendos, por clube. */
  readonly paidPoints = new Map<string, number>();
  placementPaid = false;
  /** Recompra no fim da temporada, em múltiplos dos dividendos dela (0 = sem recompra). */
  buybackMultiple = 0;
  /** Dividendos de copa já pagos por ação, por clube. */
  readonly cupPaid = new Map<string, number>();
  /** Torcedores compram o próprio time antes dos mata-matas de copa. */
  cupHype = false;
  /** Jogos em andamento com o placar parcial (só para os bots da partida; o valor justo da casa não usa). */
  private live: readonly LiveMatch[] = [];
  private cups: PreparedCup[] = [];
  private readonly gamesPerClub: number;
  /** Os jogos do campeonato como "mandante|visitante" (o placar parcial só vale para eles). */
  private readonly leaguePairs: ReadonlySet<string>;
  /** Jogos de cada clube em ordem de início, e o índice do próximo a começar. */
  private readonly fixtures = new Map<string, Match[]>();
  private readonly nextIdx = new Map<string, number>();

  constructor(
    readonly clubIds: readonly string[],
    protected readonly rules: LeagueRules,
    allMatches: readonly Match[],
    /** Pontos por jogo esperados antes de qualquer resultado. */
    private readonly priorPpg = 1.35,
    /** Peso do palpite inicial, em jogos. */
    private readonly priorWeight = 5,
  ) {
    this.gamesPerClub = (2 * allMatches.length) / clubIds.length;
    this.leaguePairs = new Set(allMatches.map((m) => `${m.home}|${m.away}`));
    for (const id of clubIds) {
      this.paidPoints.set(id, 0);
      this.fixtures.set(
        id,
        allMatches.filter((m) => m.home === id || m.away === id).sort((a, b) => kickoffTime(a) - kickoffTime(b)),
      );
      this.nextIdx.set(id, 0);
    }
    this.recompute();
  }

  /** Copas que valem dividendos nesta temporada, com todos os jogos (inclusive os que ainda vão acontecer). */
  setCups(cups: ReadonlyArray<{ matches: readonly Match[]; rules: CupRules }>): void {
    this.cups = prepareCups(cups);
  }

  /**
   * Dividendos de copa que o clube ainda pode receber, esperados com metade de
   * chance de passar de cada fase (inclusive as preliminares, que não pagam).
   */
  cupExpected(clubId: string): Cents {
    return cupExpected(clubId, this.now, this.cups);
  }

  /** Próximo jogo de copa do clube na fase em que ele está vivo. */
  nextCupMatch(clubId: string): Match | undefined {
    let best: Match | undefined;
    for (const cup of this.cups) {
      const stage = cupStage(cup, clubId, this.now);
      if (stage < 0) continue;
      for (const m of cup.byPhase.get(cup.phases[stage]!)!) {
        if ((m.home !== clubId && m.away !== clubId) || kickoffTime(m) <= this.now) continue;
        if (!best || kickoffTime(m) < kickoffTime(best)) best = m;
      }
    }
    return best;
  }

  /** Próximo jogo do clube que ainda não começou (o tempo só anda para a frente). */
  nextMatch(clubId: string): Match | undefined {
    const list = this.fixtures.get(clubId)!;
    let i = this.nextIdx.get(clubId)!;
    while (i < list.length && kickoffTime(list[i]!) <= this.now) i++;
    this.nextIdx.set(clubId, i);
    return list[i];
  }

  /**
   * Vantagem esperada do clube no jogo: pontos por jogo dele menos os do
   * adversário, mais um bônus por jogar em casa (negativo fora).
   */
  matchEdge(clubId: string, match: Match, homeBonus = 0.3): number {
    const home = match.home === clubId;
    const opponent = home ? match.away : match.home;
    return this.ppg(clubId) - this.ppg(opponent) + (home ? homeBonus : -homeBonus);
  }

  /** Os jogos em andamento e o placar parcial de cada um (item 23). */
  setLive(matches: readonly LiveMatch[]): void {
    this.live = matches;
    this.recompute();
  }

  /**
   * Pontos esperados a mais (ou a menos) que o placar parcial dá a cada clube. Só jogos deste campeonato (o par mandante e
   * visitante está no calendário dele): o jogo de copa de um clube da liga não entra; as copas ficam para outra etapa.
   */
  private liveDeltas(): Map<string, number> | undefined {
    if (this.live.length === 0) return undefined;
    const deltas = new Map<string, number>();
    for (const m of this.live) {
      if (!this.leaguePairs.has(`${m.home}|${m.away}`)) continue;
      for (const clubId of [m.home, m.away]) deltas.set(clubId, (deltas.get(clubId) ?? 0) + livePointsDelta(m, clubId));
    }
    return deltas.size > 0 ? deltas : undefined;
  }


  setKnownMatches(matches: Match[]): void {
    this.known = matches;
    this.recompute();
  }

  lastResult(clubId: string): { result: "W" | "D" | "L"; at: number } | undefined {
    for (let i = this.known.length - 1; i >= 0; i--) {
      const m = this.known[i]!;
      if (m.home !== clubId && m.away !== clubId) continue;
      const mine = m.home === clubId ? m.homeGoals! : m.awayGoals!;
      const theirs = m.home === clubId ? m.awayGoals! : m.homeGoals!;
      return { result: mine > theirs ? "W" : mine < theirs ? "L" : "D", at: finishTime(m) };
    }
    return undefined;
  }

  /** Dividendo por ação dos pontos já ganhos e ainda não pagos (sai no fechamento da rodada). */
  unpaidDividend(clubId: string): Cents {
    const points = this.projection.standings.get(clubId)?.points ?? 0;
    return Math.round((points - (this.paidPoints.get(clubId) ?? 0)) * this.rules.perPoint);
  }

  /** Vitórias seguidas do clube nos últimos jogos encerrados. */
  winStreak(clubId: string): number {
    let n = 0;
    for (let i = this.known.length - 1; i >= 0; i--) {
      const m = this.known[i]!;
      if (m.home !== clubId && m.away !== clubId) continue;
      const mine = m.home === clubId ? m.homeGoals! : m.awayGoals!;
      const theirs = m.home === clubId ? m.awayGoals! : m.homeGoals!;
      if (mine <= theirs) break;
      n++;
    }
    return n;
  }

  /**
   * Valor justo estimado (`fairValue` do motor): pontos já ganhos e ainda não
   * pagos, mais os pontos esperados nos jogos que faltam, vezes o dividendo por
   * ponto, mais o dividendo da colocação final projetada, mais os dividendos de
   * copa esperados, mais a recompra esperada. A simulação paga cada evento no
   * fechamento, então "pago" e "fechado" são o mesmo instante.
   */
  fairValue(clubId: string): Cents {
    return Math.max(0, fairValue(this.fairValueInput(clubId)));
  }

  /** Linha da tabela do clube com os jogos já encerrados. */
  standing(clubId: string): StandingRow | undefined {
    return this.projection.standings.get(clubId);
  }

  /**
   * Valor justo com outra estimativa de pontos por jogo nos jogos que faltam
   * (a mesma conta de `fairValue`, inclusive a colocação projetada com ela).
   */
  fairValueWith(clubId: string, ppg: (clubId: string) => number): Cents {
    return Math.max(0, fairValueWithPpg(this.fairValueInput(clubId), ppg));
  }

  private fairValueInput(clubId: string): FairValueInput {
    return {
      projection: this.projection,
      clubId,
      rules: this.rules,
      buybackMultiple: this.buybackMultiple,
      closedPoints: this.paidPoints.get(clubId) ?? 0,
      placementClosed: this.placementPaid,
      cupClosed: this.cupPaid.get(clubId) ?? 0,
      cupExpected: this.cupExpected(clubId),
    };
  }

  private ppg(clubId: string): number {
    return pointsPerGame(this.projection, clubId);
  }

  private recompute(): void {
    this.projection = projectLeague(this.known, this.clubIds, this.gamesPerClub, { ppg: this.priorPpg, weight: this.priorWeight }, this.liveDeltas());
  }
}
