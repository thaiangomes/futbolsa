/**
 * O que o placar parcial de um jogo em andamento muda nos pontos esperados do clube (item 23 das melhorias da partida de
 * teste). Só para os bots da partida: o valor justo da casa, os dividendos e as classificações continuam usando só jogos
 * encerrados.
 *
 * Modelo simples, de propósito: cada time faz gols no que resta do jogo como um processo de Poisson, com a média do
 * Brasileirão por jogo (mandante 1,45 e visitante 1,15) vezes a fração do jogo que falta. Dos gols que ainda vêm sai a
 * chance de vitória, empate e derrota, e dela os pontos esperados (3, 1 ou 0). O efeito no valor justo é a diferença entre
 * os pontos esperados com o placar de agora e os esperados no apito inicial (0 a 0, jogo inteiro pela frente).
 */

export interface LiveMatch {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  /** Minuto de jogo (0 a 90). */
  minute: number;
}

const GOLS_MANDANTE = 1.45;
const GOLS_VISITANTE = 1.15;
const DURACAO = 90;
/** Gols a mais, de cada lado, que a conta considera (a chance de passar disso é desprezível). */
const MAX_GOLS = 12;

/** O minuto de jogo pelo tempo corrido desde o apito: o intervalo (cerca de 15 minutos) não conta. */
export function gameMinute(elapsedMs: number): number {
  const e = Math.max(0, elapsedMs / 60_000);
  if (e <= 47) return e;
  if (e < 62) return 45; // intervalo
  return Math.min(DURACAO, e - 15);
}

function poisson(lambda: number): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= MAX_GOLS; k++) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  return out;
}

/** Pontos esperados do clube no fim do jogo, dado o placar (gols dele e do adversário) e o minuto. */
export function expectedPoints(goalsFor: number, goalsAgainst: number, minute: number, atHome: boolean): number {
  const left = Math.max(0, (DURACAO - minute) / DURACAO);
  const mine = poisson((atHome ? GOLS_MANDANTE : GOLS_VISITANTE) * left);
  const theirs = poisson((atHome ? GOLS_VISITANTE : GOLS_MANDANTE) * left);
  let points = 0;
  for (let i = 0; i <= MAX_GOLS; i++) {
    for (let j = 0; j <= MAX_GOLS; j++) {
      const diff = goalsFor + i - (goalsAgainst + j);
      points += mine[i]! * theirs[j]! * (diff > 0 ? 3 : diff === 0 ? 1 : 0);
    }
  }
  return points;
}

/** Quantos pontos a mais (ou a menos) o clube espera do jogo, comparado com o apito inicial. */
export function livePointsDelta(match: LiveMatch, clubId: string): number {
  const atHome = match.home === clubId;
  if (!atHome && match.away !== clubId) return 0;
  const mine = atHome ? match.homeGoals : match.awayGoals;
  const theirs = atHome ? match.awayGoals : match.homeGoals;
  return expectedPoints(mine, theirs, match.minute, atHome) - expectedPoints(0, 0, 0, atHome);
}
