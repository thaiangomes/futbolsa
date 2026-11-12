import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { COMMON_ERROR_MESSAGES, type CommonErrorCode, type ErrorResponse } from "@futbolsa/contracts";
import { DomainError } from "./errors.js";

/** O código geral de cada status que não vem de um `DomainError`. */
const CODE_BY_STATUS: Record<number, CommonErrorCode> = {
  400: "invalid_input",
  404: "not_found",
  413: "payload_too_large",
  415: "invalid_input",
  429: "too_many_requests",
};

/** Converte qualquer erro no corpo `{ code, message }` da API, sem vazar detalhe interno. */
export function toErrorResponse(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof DomainError) {
    const body: ErrorResponse = { ...error.details, code: error.code, message: error.message };
    if (error.fields) body.fields = error.fields;
    return { status: error.status, body };
  }
  // HttpException do Nest (404 de rota, 429 do limite) e erros do Fastify com statusCode
  // (corpo grande demais, JSON malformado): só o status é aproveitado, nunca a mensagem.
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
  const code = CODE_BY_STATUS[status];
  if (code) return { status, body: { code, message: COMMON_ERROR_MESSAGES[code] } };
  return { status: 500, body: { code: "internal_error", message: COMMON_ERROR_MESSAGES.internal_error } };
}

/** Filtro global: toda resposta de erro tem o mesmo formato (Arquitetura da Fase 1, Contratos da API). */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("Erro");

  catch(error: unknown, host: ArgumentsHost): void {
    const { status, body } = toErrorResponse(error);
    if (status >= 500) this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(status).send(body);
  }
}
