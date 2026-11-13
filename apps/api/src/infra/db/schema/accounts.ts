import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, money, oneOf } from "./base.js";
import { seasons } from "./admin.js";
import { PLAYER_NOTICE_KINDS, USER_ROLES, USER_STATUSES } from "./values.js";

/** Dono: módulo `accounts` (Conta e login). */

export const users = futbolsa.table(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Apagado na exclusão da conta. */
    email: text("email"),
    nickname: text("nickname"),
    role: text("role").notNull().default("player"),
    status: text("status").notNull().default("active"),
    termsAcceptedAt: instant("terms_accepted_at"),
    blockedReason: text("blocked_reason"),
    createdAt: instant("created_at").notNull().defaultNow(),
    deletedAt: instant("deleted_at"),
  },
  (t) => [
    // únicos sem diferenciar maiúsculas
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    uniqueIndex("users_nickname_lower_key").on(sql`lower(${t.nickname})`),
    check("users_role_check", oneOf(t.role, USER_ROLES)),
    check("users_status_check", oneOf(t.status, USER_STATUSES)),
  ],
);

/** Liga o usuário do jogo à identidade do sistema de login (adaptador). */
export const authIdentities = futbolsa.table(
  "auth_identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] })],
);

/** E-mails liberados para criar conta. Guardados em minúsculas. */
export const invites = futbolsa.table(
  "invites",
  {
    email: text("email").primaryKey(),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    usedAt: instant("used_at"),
  },
  (t) => [check("invites_email_lower_check", sql`${t.email} = lower(${t.email})`)],
);

/** Resumo de cada temporada do jogador, para o histórico. */
export const seasonResults = futbolsa.table(
  "season_results",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    /** Patrimônio final e a base do retorno, para o retorno exato sair como fração. */
    finalEquity: money("final_equity").notNull(),
    base: money("base").notNull(),
    position: integer("position"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.seasonId] })],
);

/** Avisos ao jogador (advertência e banimento por trapaça, F14). O e-mail é enviado por uma tarefa, da fila. */
export const playerNotices = futbolsa.table(
  "player_notices",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    body: jsonb("body").notNull(),
    createdAt: instant("created_at").notNull(),
    readAt: instant("read_at"),
    emailSentAt: instant("email_sent_at"),
    emailAttempts: integer("email_attempts").notNull().default(0),
  },
  (t) => [
    index("player_notices_user_unread_idx").on(t.userId).where(sql`${t.readAt} is null`),
    index("player_notices_mail_idx").on(t.id).where(sql`${t.emailSentAt} is null`),
    check("player_notices_kind_check", oneOf(t.kind, PLAYER_NOTICE_KINDS)),
  ],
);
