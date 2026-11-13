/**
 * Códigos de erro da entrada no meio da temporada, com a mensagem que o jogador vê. O código diz o que a tela faz.
 * `market_suspended` leva o motivo do admin na mensagem (montada por quem lança).
 */
export const ENTRY_ERROR_MESSAGES = {
  entry_not_open: "A entrada no meio da temporada só abre depois do fechamento do IPO.",
  entry_not_ready: "Estamos fechando o IPO, tente de novo em instantes.",
  market_suspended: "O mercado está suspenso. Volte depois.",
  entry_window_closed: "A entrada no meio da temporada acabou: sua conta entra no IPO do ano seguinte.",
  already_entered: "Você já escolheu como entrar nesta temporada.",
  account_blocked: "Sua conta está bloqueada e não pode entrar na temporada.",
  entry_busy: "Muita gente entrando agora, tente de novo em instantes.",
} as const;

export type EntryErrorCode = keyof typeof ENTRY_ERROR_MESSAGES;
