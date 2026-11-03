/** Códigos de fechamento da conexão e o que o cliente faz com cada um (ver o Plano do WebSocket). */
export const CLOSE_CODES = {
  /** API desligando. */
  serverShutdown: 1001,
  /** Mais de 20 mensagens por segundo. */
  rateLimited: 1008,
  /** Mensagem maior que 4 KB. */
  messageTooBig: 1009,
  /** Cliente lento ou API cheia. */
  tryAgainLater: 1013,
  /** Token inválido. */
  invalidToken: 4401,
  /** Passou dos 55 minutos: reabrir com token novo. */
  sessionExpired: 4402,
  /** Conta excluída ou papel mudou. */
  accountChanged: 4403,
  /** Nenhuma mensagem válida em 10 segundos. */
  authTimeout: 4408,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];
