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
    /**
     * Campos a mais no corpo da resposta, quando o contrato da rota os prevê (o `preview` do `correction_stale`).
     * Não substituem `code`, `message` nem `fields`.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
