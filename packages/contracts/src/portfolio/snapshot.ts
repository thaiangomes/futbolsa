import { z } from "zod";

/** A foto mensal da carteira no perfil público: só fatias em décimos de ponto percentual, nunca quantidade nem valor. */
export const snapshotSchema = z.strictObject({
  /** `2027-05`. */
  month: z.string(),
  /** Ordenadas por tamanho, o caixa por último. `key` é o ticker ou `cash`. */
  slices: z.array(z.strictObject({ key: z.string(), name: z.string().nullable(), permille: z.number().int() })),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
