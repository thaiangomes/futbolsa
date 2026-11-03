import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { COMMON_ERROR_MESSAGES } from "@futbolsa/contracts";
import { DomainError } from "./errors.js";

/**
 * Valida corpo, parâmetros ou consulta pelo esquema zod do contrato. Recusa com
 * `invalid_input` e a lista dos campos que falharam, sem devolver o valor enviado.
 * Uso: `@Body(new ZodValidationPipe(esquema)) corpo`.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const fields = [...new Set(result.error.issues.map((i) => (i.path.length ? i.path.join(".") : "(corpo)")))];
    throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, fields);
  }
}
