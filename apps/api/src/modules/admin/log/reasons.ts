/**
 * As ações do admin que vão para o registro, com nome fixo (Admin, critério 33). Cada uma diz se
 * o motivo é obrigatório: corrigir um placar, a classificação ou suspender um clube muda dinheiro
 * dos jogadores, então o admin explica por quê; as outras aceitam motivo e não exigem.
 *
 * Toda ação gravada precisa estar aqui: o `record` recusa nome desconhecido. As ações da F12 e da
 * F14 acrescentam as delas nesta mesma tabela.
 */
export const ADMIN_ACTIONS = {
  // Jogos (F7)
  "match.create": { reasonRequired: true },
  "match.update": { reasonRequired: true },
  // Classificação oficial (F7)
  "standings.update": { reasonRequired: true },
  "standings.confirm": { reasonRequired: false },
  // Temporada e copas (F7)
  "season.create": { reasonRequired: false },
  "season.update": { reasonRequired: false },
  "season.clubs.update": { reasonRequired: false },
  "season.rules.update": { reasonRequired: false },
  "cup.update": { reasonRequired: false },
  "cup.confirm": { reasonRequired: false },
  // Adiar o fechamento das ofertas do IPO (F8): como as outras ações de temporada, motivo aceito e não exigido.
  "season.ipo.postpone": { reasonRequired: false },
  // Suspensão do mercado (F7)
  "suspension.set": { reasonRequired: true },
  "suspension.clear": { reasonRequired: false },
  // Pagamentos (F12): a aprovação não pede motivo; a correção mexe no dinheiro dos outros e pede
  "payout.approve": { reasonRequired: false },
  "payout.correct": { reasonRequired: true },
  // Convites e papéis (F5)
  "invite.create": { reasonRequired: false },
  "invite.revoke": { reasonRequired: false },
  "player.role": { reasonRequired: true },
} as const satisfies Record<string, { reasonRequired: boolean }>;

export type AdminAction = keyof typeof ADMIN_ACTIONS;

/** Se a ação exige motivo. Ação fora da tabela é erro de programação, não do admin. */
export function reasonRequired(action: string): boolean {
  if (!Object.hasOwn(ADMIN_ACTIONS, action)) {
    throw new Error(`Ação do admin desconhecida: "${action}". Registre-a em ADMIN_ACTIONS (admin/log/reasons.ts) antes de gravar.`);
  }
  return ADMIN_ACTIONS[action as AdminAction].reasonRequired;
}
