import { z } from "zod";
import { IPO_BLOCKERS } from "../ipo/errors.js";

/** `GET /admin/overview`: o que pede atenção do admin (tela inicial). */
export const overviewSchema = z.strictObject({
  pendingMatches: z.number().int(),
  standingsNotConfirmed: z.array(z.enum(["brasileirao-a", "brasileirao-b"])),
  cupsNotConfirmed: z.array(z.enum(["copa-do-brasil", "libertadores", "sulamericana"])),
  suspendedClubs: z.array(z.string()),
  marketSuspended: z.boolean(),
  /**
   * Por que o IPO não abriu (mensagens em `IPO_BLOCKER_MESSAGES`). Vazia, salvo com a temporada em
   * preparação e o horário de abertura já passado.
   */
  ipoBlockers: z.array(z.enum(IPO_BLOCKERS)),
  /**
   * Clubes cuja liquidação do IPO deu erro na última passada da tarefa (com a mensagem). Vazia quando está
   * tudo certo; enquanto houver clube aqui, a negociação não abre e as contas excluídas esperam.
   */
  ipoSettlementFailures: z.array(z.strictObject({ ticker: z.string(), error: z.string() })),
  /** Pagamentos aguardando aprovação (F12). */
  pendingPayouts: z.number().int(),
  /** Eventos aprovados com crédito ainda saindo em lotes. */
  settlingPayouts: z.number().int(),
  /** Há resultado mudado depois de pago: uma correção a aplicar. */
  correctionToApply: z.boolean(),
});
export type Overview = z.infer<typeof overviewSchema>;
