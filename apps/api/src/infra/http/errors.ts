/**
 * Erro de regra que vai ao jogador: um código que diz o que a tela faz, o status HTTP e a
 * mensagem em português. Nunca leva detalhe interno (SQL, pilha, ids de outras pessoas).
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    /** Só em `invalid_input`: os campos que falharam. */
    readonly fields?: string[],
  ) {
    super(message);
    this.name = "DomainError";
  }
}
