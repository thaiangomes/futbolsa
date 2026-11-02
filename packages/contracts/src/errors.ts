import { z } from "zod";

/** Corpo de toda resposta de erro da API: o código diz o que a tela faz; a mensagem é em português. */
export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Só em `invalid_input`: os campos que falharam, sem eco do valor enviado. */
  fields: z.array(z.string()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Erros gerais de qualquer rota. */
export const COMMON_ERROR_MESSAGES = {
  invalid_input: "Dados inválidos.",
  not_found: "Não encontrado.",
  payload_too_large: "Requisição grande demais.",
  too_many_requests: "Muitas tentativas seguidas. Espere um pouco e tente de novo.",
  internal_error: "Algo deu errado do nosso lado. Tente de novo em instantes.",
} as const;

export type CommonErrorCode = keyof typeof COMMON_ERROR_MESSAGES;
