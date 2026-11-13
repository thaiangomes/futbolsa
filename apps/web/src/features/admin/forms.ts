import { adminReasonSchema } from "@futbolsa/contracts";

/** O mesmo motivo que a API exige (3 a 500 caracteres): a tela avisa antes de enviar, a API recusa de qualquer jeito. */
export function reasonFeedback(value: string): { ok: boolean; message: string } {
  if (!adminReasonSchema.safeParse(value).success) {
    return { ok: false, message: value.trim().length === 0 ? "Explique o motivo: ele fica no registro do admin." : "Use de 3 a 500 caracteres." };
  }
  return { ok: true, message: "O motivo fica no registro do admin." };
}

/** Tira dos erros da API a mensagem que a tela mostra. */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Algo deu errado. Tente de novo.";
}

/** Move um clube uma posição para cima (`-1`) ou para baixo (`1`) na ordem da classificação. */
export function moveInOrder(order: readonly number[], clubId: number, direction: -1 | 1): number[] {
  const i = order.indexOf(clubId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Os clubes cuja posição difere da que a fonte traz (para a tela destacar a diferença). */
export function differsFromSource(rows: ReadonlyArray<{ position: number; sourcePosition: number | null }>): number[] {
  return rows.flatMap((r, i) => (r.sourcePosition !== null && r.sourcePosition !== r.position ? [i] : []));
}

/** Reais e data de Brasília: moram em `lib/format` (o IPO usa os mesmos). */
export { formatCents, formatInstant } from "../../lib/format";

/** Nome de cada ação do registro, em português. */
export const ACTION_LABELS: Record<string, string> = {
  "player.block": "Jogador bloqueado",
  "player.unblock": "Jogador desbloqueado",
  "player.delete": "Conta excluída pelo admin",
  "player.adjust": "Saldo ajustado",
  "bots.update": "Bots ligados ou desligados",
  "season.bots_in_rankings": "Bots nos rankings",
  "match.create": "Jogo cadastrado",
  "match.update": "Jogo corrigido",
  "standings.update": "Classificação corrigida",
  "standings.confirm": "Classificação conferida",
  "season.create": "Temporada criada",
  "season.update": "Temporada alterada",
  "season.ipo.postpone": "Fechamento do IPO adiado",
  "season.close": "Temporada encerrada",
  "season.clubs.update": "Clubes da temporada",
  "season.rules.update": "Valores da temporada",
  "cup.update": "Tabela da copa alterada",
  "cup.confirm": "Tabela da copa confirmada",
  "import.run": "Importação na hora",
  "suspension.set": "Negociação suspensa",
  "suspension.clear": "Negociação retomada",
  "market-maker.update": "Percentuais do formador alterados",
  "invite.create": "Convite criado",
  "invite.revoke": "Convite retirado",
  "player.role": "Papel alterado",
  "payout.approve": "Pagamento aprovado",
  "payout.correct": "Correção de pagamento aplicada",
};

export const COMPETITION_LABELS: Record<string, string> = {
  "brasileirao-a": "Série A",
  "brasileirao-b": "Série B",
  "copa-do-brasil": "Copa do Brasil",
  libertadores: "Libertadores",
  sulamericana: "Sul-Americana",
};
