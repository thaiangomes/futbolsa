import { z } from "zod";

/**
 * O relógio da partida de teste (F17). A rota só existe na API da partida (`apps/api/partida/`); em qualquer outra API o admin
 * responde 404 e a tela não aparece no menu.
 */
export const estadoDoRelogioSchema = z.object({
  instante: z.string(),
  modo: z.enum(["pausado", "tempo-real"]),
  limite: z.string().nullable(),
  aguardando: z.boolean(),
  ultimoResultado: z.string().nullable(),
  ocupado: z.string().nullable(),
  dadosDe: z.string().nullable(),
});
export type EstadoDoRelogio = z.infer<typeof estadoDoRelogioSchema>;

export const partidaViewSchema = z.object({ partida: z.literal(true), relogio: estadoDoRelogioSchema });

export const respostaDoRelogioSchema = z.object({ estado: estadoDoRelogioSchema, avancou: z.boolean(), mensagem: z.string() });
export type RespostaDoRelogio = z.infer<typeof respostaDoRelogioSchema>;

export type PedidoDoRelogio = { acao: "dia" } | { acao: "rodada" } | { acao: "ate"; data: string } | { acao: "atualizar" } | { acao: "pausar" } | { acao: "tempo-real" };
