import { integer, jsonb, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { futbolsa, instant } from "./base.js";
import { users } from "./accounts.js";

/** Dono: `infra/db`. Uma chamada repetida com a mesma chave devolve a mesma resposta. */
export const idempotencyKeys = futbolsa.table(
  "idempotency_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(),
    statusCode: integer("status_code").notNull(),
    response: jsonb("response").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
