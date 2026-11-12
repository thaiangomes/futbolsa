import { rank, type Cents } from "@futbolsa/engine";

export interface Measured {
  walletId: number;
  /** Patrimônio no instante da medida. */
  equity: Cents;
  /** Patrimônio de partida; ≤ 0 deixa o jogador "sem base" (P8). */
  base: Cents;
}

export interface BuiltRow extends Measured {
  position: number;
  /** Retorno em pontos-base, ou nulo quando está sem base. */
  returnBp: number | null;
}

/**
 * Monta as posições com o `rank` do motor (empate divide a posição: 1, 2, 2, 4). Quem está sem base (base ≤ 0, que o
 * motor recusa) fica depois de todos, empatado entre si (P8). A ordem de entrada em `rows` desempata a ordenação
 * estável. Devolve as linhas na ordem do ranking.
 */
export function buildRanking(rows: readonly Measured[]): BuiltRow[] {
  const withBase = rows.filter((r) => r.base > 0);
  const noBase = rows.filter((r) => r.base <= 0);
  const ranked = rank(withBase.map((r) => ({ id: String(r.walletId), equity: r.equity, base: r.base })));
  const out: BuiltRow[] = ranked.map((r) => ({ walletId: Number(r.id), equity: r.equity, base: r.base, position: r.position, returnBp: r.returnBp }));
  const lastPosition = withBase.length + 1;
  for (const r of noBase) out.push({ ...r, position: lastPosition, returnBp: null });
  return out;
}
