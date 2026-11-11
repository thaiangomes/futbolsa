import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { COMMON_ERROR_MESSAGES } from "@futbolsa/contracts";
import type { Tx } from "../../../infra/db/index.js";
import { idempotencyKeys } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";

/**
 * Chamada repetida que não duplica (P4 do Plano do livro de ofertas e formador; Arquitetura da Fase 1, "Chamada
 * repetida não duplica"). O site manda uma `Idempotency-Key` por envio e repete a mesma chave quando a rede falha;
 * a API grava a chave na **mesma transação** da ordem, então ou ficam as duas ou nenhuma.
 *
 * A tabela `idempotency_keys` tem `(user_id, key)` como chave primária, o status e a resposta. O resumo do corpo
 * (para reconhecer a mesma chave com outra ordem) vai dentro da resposta guardada, em `requestHash`: a tabela não
 * tem coluna própria para ele, e a resposta só é lida por aqui.
 *
 * 1. `claimIdempotencyKey` faz o `INSERT ... ON CONFLICT DO NOTHING` antes de tudo, com a resposta ainda
 *    pendente (status 0). Uma segunda chamada com a mesma chave, ao mesmo tempo, espera no índice único até a
 *    primeira terminar: se ela confirmou, o `INSERT` não grava nada e a segunda lê a resposta dela; se desfez, a
 *    segunda grava a chave e segue como se fosse a primeira.
 * 2. `saveIdempotentResponse` troca a resposta pendente pela de verdade (a ordem aceita ou a recusa), antes do
 *    `COMMIT`. Nenhuma resposta pendente fica gravada: ela só existe dentro da transação que a criou.
 */

/** O cabeçalho: de 1 a 200 caracteres visíveis (o site manda um UUID). */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);

/** A chave do cabeçalho, conferida; sem cabeçalho, `undefined` (a ordem entra sem idempotência). */
export function parseIdempotencyKey(header: unknown): string | undefined {
  if (header === undefined) return undefined;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["Idempotency-Key"]);
  return parsed.data;
}

/**
 * O resumo do pedido: a rota e o corpo já conferido pelo esquema, com as chaves em ordem. A rota entra no resumo
 * para a mesma chave não valer em duas rotas diferentes (a F14 também usará `Idempotency-Key`).
 */
export function requestHash(route: string, body: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(body).sort().map((k) => [k, body[k]]));
  return createHash("sha256").update(`${route}\n${canonical}`).digest("hex");
}

/** A resposta guardada de uma chamada: o status HTTP e o corpo (o da ordem aceita ou o `{ code, message }`). */
export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyClaim =
  /** A chave é nova (ou a chamada anterior desfez): esta chamada faz a ordem e guarda a resposta. */
  | { kind: "fresh" }
  /** A mesma chave com o mesmo pedido já foi respondida: devolve a mesma resposta. */
  | { kind: "replay"; response: StoredResponse }
  /** A mesma chave com outro pedido. */
  | { kind: "conflict" };

interface StoredPayload {
  requestHash: string;
  body?: unknown;
}

const PENDING = 0;

export interface IdempotencyRef {
  userId: string;
  key: string;
  requestHash: string;
}

/** O passo 1: reserva a chave na transação, ou devolve o que a chamada anterior com ela respondeu. */
export async function claimIdempotencyKey(tx: Tx, ref: IdempotencyRef, at: Date): Promise<IdempotencyClaim> {
  const inserted = await tx.db
    .insert(idempotencyKeys)
    .values({ userId: ref.userId, key: ref.key, statusCode: PENDING, response: { requestHash: ref.requestHash } satisfies StoredPayload, createdAt: at })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return { kind: "fresh" };

  // O INSERT esperou a outra transação com a mesma chave confirmar: esta leitura, uma instrução nova, já a vê.
  const [row] = await tx.db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, ref.userId), eq(idempotencyKeys.key, ref.key)));
  if (!row) throw new Error(`a chave de idempotência ${ref.key} sumiu entre o INSERT e a leitura`);
  const stored = row.response as StoredPayload;
  if (stored.requestHash !== ref.requestHash) return { kind: "conflict" };
  if (row.statusCode === PENDING) throw new Error(`a chave de idempotência ${ref.key} foi confirmada sem resposta`);
  return { kind: "replay", response: { status: row.statusCode, body: stored.body } };
}

/** O passo 2: guarda a resposta na chave reservada por esta transação. */
export async function saveIdempotentResponse(tx: Tx, ref: IdempotencyRef, response: StoredResponse): Promise<void> {
  const updated = await tx.db
    .update(idempotencyKeys)
    .set({ statusCode: response.status, response: { requestHash: ref.requestHash, body: response.body } satisfies StoredPayload })
    .where(and(eq(idempotencyKeys.userId, ref.userId), eq(idempotencyKeys.key, ref.key), eq(idempotencyKeys.statusCode, PENDING)))
    .returning({ key: idempotencyKeys.key });
  if (updated.length === 0) throw new Error(`a chave de idempotência ${ref.key} não foi reservada por esta transação`);
}
