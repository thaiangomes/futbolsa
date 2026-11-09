import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ERROR_MESSAGES } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { adminLog } from "../../src/infra/db/schema/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import { AdminLogService, ADMIN_ACTIONS, reasonRequired } from "../../src/modules/admin/log/index.js";
import { createAccount } from "../support/accounts.js";
import { useTestDatabase } from "../support/db.js";

/** A mensagem do Postgres por trás do erro do Drizzle (o Drizzle embrulha o erro do banco). */
async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(error);
  }
  throw new Error("era para o banco recusar");
}

describe("registro do admin (record)", () => {
  const database = useTestDatabase(5);
  const clock = new FixedClock(new Date("2027-05-20T15:00:00Z"));
  let log: AdminLogService;
  beforeAll(() => {
    log = new AdminLogService(clock, database.db);
  });
  const rowsOf = (actorId: string) => database.db.select().from(adminLog).where(eq(adminLog.actorId, actorId));

  it("admin 33: grava autor, hora do relógio, alvo, antes, depois e motivo", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    await withTransaction(database.db, (tx) =>
      log.record(tx, {
        actorId: admin.id,
        action: "player.role",
        targetType: "user",
        targetId: "u-1",
        before: { role: "player" },
        after: { role: "admin" },
        reason: "ajuda no admin",
      }),
    );
    const rows = await rowsOf(admin.id);
    expect(rows).toEqual([
      expect.objectContaining({
        actorId: admin.id,
        at: clock.now(),
        action: "player.role",
        targetType: "user",
        targetId: "u-1",
        before: { role: "player" },
        after: { role: "admin" },
        reason: "ajuda no admin",
      }),
    ]);
  });

  it("admin 33: ação desfeita não deixa linha no registro", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    await expect(
      withTransaction(database.db, async (tx) => {
        await log.record(tx, { actorId: admin.id, action: "invite.create" });
        throw new Error("a ação falhou depois de registrar");
      }),
    ).rejects.toThrow();
    expect(await rowsOf(admin.id)).toHaveLength(0);
  });

  it("admin 33: a tabela de ações diz quais exigem motivo", () => {
    for (const action of ["match.create", "match.update", "standings.update", "suspension.set", "player.role"]) {
      expect(reasonRequired(action), action).toBe(true);
    }
    for (const action of [
      "standings.confirm",
      "season.create",
      "season.update",
      "season.clubs.update",
      "season.rules.update",
      "cup.update",
      "cup.confirm",
      "import.run",
      "season.ipo.postpone",
      "suspension.clear",
      "invite.create",
      "invite.revoke",
    ]) {
      expect(reasonRequired(action), action).toBe(false);
    }
    // as duas dos pagamentos (F12): aprovar não pede motivo, corrigir pede
    expect(reasonRequired("payout.approve")).toBe(false);
    expect(reasonRequired("payout.correct")).toBe(true);
    expect(Object.keys(ADMIN_ACTIONS)).toHaveLength(19);
  });

  it("admin 33: ação sem motivo que exige motivo é recusada e nada é gravado", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    for (const action of ["match.create", "match.update", "standings.update", "suspension.set", "player.role"]) {
      for (const reason of [undefined, "", "   \n\t "]) {
        const attempt = withTransaction(database.db, (tx) =>
          log.record(tx, { actorId: admin.id, action, targetType: "x", targetId: "1", reason }),
        );
        await expect(attempt, `${action} ${JSON.stringify(reason)}`).rejects.toBeInstanceOf(DomainError);
        await expect(attempt).rejects.toMatchObject({
          code: "reason_required",
          status: 400,
          message: ADMIN_ERROR_MESSAGES.reason_required,
        });
      }
    }
    expect(await rowsOf(admin.id)).toHaveLength(0);
  });

  it("admin 33: ação que não exige motivo grava sem motivo", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    await withTransaction(database.db, async (tx) => {
      await log.record(tx, { actorId: admin.id, action: "standings.confirm", targetType: "standings", targetId: "serie-a" });
      await log.record(tx, { actorId: admin.id, action: "suspension.clear", reason: "   " });
    });
    const rows = await rowsOf(admin.id);
    expect(rows.map((r) => [r.action, r.reason])).toEqual(
      expect.arrayContaining([
        ["standings.confirm", null],
        ["suspension.clear", null],
      ]),
    );
  });

  it("admin 33: o motivo é gravado sem espaços nas pontas", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    await withTransaction(database.db, (tx) =>
      log.record(tx, { actorId: admin.id, action: "match.update", reason: "  placar errado na fonte \n" }),
    );
    const [row] = await rowsOf(admin.id);
    expect(row!.reason).toBe("placar errado na fonte");
  });

  it("ação desconhecida é erro de programação e nada é gravado", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    expect(() => reasonRequired("match.delete")).toThrow(/match\.delete/);
    const attempt = withTransaction(database.db, (tx) =>
      log.record(tx, { actorId: admin.id, action: "match.delete", reason: "qualquer" }),
    );
    await expect(attempt).rejects.toThrow(/match\.delete/);
    await expect(attempt).rejects.not.toBeInstanceOf(DomainError);
    expect(await rowsOf(admin.id)).toHaveLength(0);
  });

  it("registro não se edita nem se apaga", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    await withTransaction(database.db, (tx) => log.record(tx, { actorId: admin.id, action: "season.create" }));
    expect(
      await errorMessage(database.db.update(adminLog).set({ reason: "mudei" }).where(eq(adminLog.actorId, admin.id))),
    ).toMatch(/history_immutable/);
    expect(await errorMessage(database.db.delete(adminLog).where(eq(adminLog.actorId, admin.id)))).toMatch(/history_immutable/);
    expect(await rowsOf(admin.id)).toHaveLength(1);
  });

  it("nenhum e-mail aparece em before ou after", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    const attempts = [
      { before: { email: "ana@exemplo.com" } },
      { after: { players: [{ id: 1, contato: "Fala com bia@exemplo.com.br" }] } },
      { after: "caio@exemplo.com" },
    ];
    for (const extra of attempts) {
      await expect(
        withTransaction(database.db, (tx) => log.record(tx, { actorId: admin.id, action: "season.update", ...extra })),
        JSON.stringify(extra),
      ).rejects.toThrow(/e-mail/);
    }
    expect(await rowsOf(admin.id)).toHaveLength(0);
    // dados do jogo e o e-mail embaralhado (hex do HMAC) passam
    await withTransaction(database.db, (tx) =>
      log.record(tx, {
        actorId: admin.id,
        action: "season.update",
        before: { nickname: "ana_10", ids: [1, 2] },
        after: { nickname: "ana@10" },
        targetId: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      }),
    );
    expect(await rowsOf(admin.id)).toHaveLength(1);
  });

  it("nenhum e-mail aparece no motivo: o admin recebe 400 com a explicação e nada é gravado", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    for (const [action, reason] of [
      ["season.update", "pedido de ana@exemplo.com por fora"],
      ["suspension.set", "denúncia enviada por bia@exemplo.com.br"],
    ] as const) {
      await expect(
        withTransaction(database.db, (tx) => log.record(tx, { actorId: admin.id, action, reason })),
        reason,
      ).rejects.toMatchObject({ code: "reason_has_email", status: 400, message: ADMIN_ERROR_MESSAGES.reason_has_email });
    }
    expect(await rowsOf(admin.id)).toHaveLength(0);
    // um apelido com arroba não é e-mail
    await withTransaction(database.db, (tx) => log.record(tx, { actorId: admin.id, action: "season.update", reason: "pedido de @ana_10" }));
    expect(await rowsOf(admin.id)).toHaveLength(1);
  });
});

describe("registro do admin (listLog)", () => {
  const database = useTestDatabase(5);
  const clock = new FixedClock(new Date("2027-06-01T12:00:00Z"));
  let log: AdminLogService;
  beforeAll(() => {
    log = new AdminLogService(clock, database.db);
  });
  const recordAt = async (at: string, actorId: string, action: string, reason?: string) => {
    clock.set(new Date(at));
    await withTransaction(database.db, (tx) => log.record(tx, { actorId, action, reason }));
  };
  const query = (q: Partial<Parameters<AdminLogService["listLog"]>[0]>) => log.listLog({ page: 1, pageSize: 50, ...q });

  it("admin 33: lista do mais novo para o mais antigo, com o apelido do autor", async () => {
    const admin = await createAccount(database.db, { role: "admin", nickname: "chefe_lista" });
    await recordAt("2027-06-01T10:00:00Z", admin.id, "season.create");
    await recordAt("2027-06-01T12:00:00Z", admin.id, "match.update", "placar");
    await recordAt("2027-06-01T11:00:00Z", admin.id, "cup.update");
    const res = await query({ actorId: admin.id });
    expect(res.total).toBe(3);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(50);
    expect(res.entries.map((e) => e.action)).toEqual(["match.update", "cup.update", "season.create"]);
    expect(res.entries[0]).toEqual({
      id: expect.any(Number),
      actor: { id: admin.id, nickname: "chefe_lista" },
      at: "2027-06-01T12:00:00.000Z",
      action: "match.update",
      targetType: null,
      targetId: null,
      before: null,
      after: null,
      reason: "placar",
    });
  });

  it("admin 33: no mesmo instante, a entrada gravada depois vem primeiro", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    await recordAt("2027-06-02T10:00:00Z", admin.id, "season.create");
    await recordAt("2027-06-02T10:00:00Z", admin.id, "season.update");
    const res = await query({ actorId: admin.id });
    expect(res.entries.map((e) => e.action)).toEqual(["season.update", "season.create"]);
    expect(res.entries[0]!.id).toBeGreaterThan(res.entries[1]!.id);
  });

  it("admin 33: filtra por autor e por ação", async () => {
    const ana = await createAccount(database.db, { role: "admin" });
    const bia = await createAccount(database.db, { role: "admin" });
    await recordAt("2027-06-03T10:00:00Z", ana.id, "cup.confirm");
    await recordAt("2027-06-03T11:00:00Z", ana.id, "season.update");
    await recordAt("2027-06-03T12:00:00Z", bia.id, "cup.confirm");
    const byAna = await query({ actorId: ana.id });
    expect(byAna.total).toBe(2);
    expect(byAna.entries.every((e) => e.actor.id === ana.id)).toBe(true);
    const anaCup = await query({ actorId: ana.id, action: "cup.confirm" });
    expect(anaCup.total).toBe(1);
    expect(anaCup.entries.map((e) => [e.actor.id, e.action])).toEqual([[ana.id, "cup.confirm"]]);
    const cups = await query({ action: "cup.confirm" });
    expect(cups.entries.map((e) => e.actor.id)).toEqual(expect.arrayContaining([ana.id, bia.id]));
    expect(cups.entries.every((e) => e.action === "cup.confirm")).toBe(true);
  });

  it("admin 33: filtra por período, do início (inclusive) ao fim (exclusive)", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    await recordAt("2027-06-04T09:59:59Z", admin.id, "season.create");
    await recordAt("2027-06-04T10:00:00Z", admin.id, "season.update");
    await recordAt("2027-06-04T11:00:00Z", admin.id, "cup.update");
    await recordAt("2027-06-04T12:00:00Z", admin.id, "cup.confirm");
    const res = await query({ actorId: admin.id, from: "2027-06-04T10:00:00Z", to: "2027-06-04T12:00:00Z" });
    expect(res.total).toBe(2);
    expect(res.entries.map((e) => e.action)).toEqual(["cup.update", "season.update"]);
    // o instante pode vir com fuso
    const local = await query({ actorId: admin.id, from: "2027-06-04T09:00:00-03:00" });
    expect(local.entries.map((e) => e.action)).toEqual(["cup.confirm"]);
  });

  it("admin 33: pagina, com o total dos filtros", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    for (let i = 0; i < 5; i++) await recordAt(`2027-06-05T1${i}:00:00Z`, admin.id, "season.update");
    const page2 = await query({ actorId: admin.id, page: 2, pageSize: 2 });
    expect(page2.total).toBe(5);
    expect(page2.page).toBe(2);
    expect(page2.pageSize).toBe(2);
    expect(page2.entries.map((e) => e.at)).toEqual(["2027-06-05T12:00:00.000Z", "2027-06-05T11:00:00.000Z"]);
    const page3 = await query({ actorId: admin.id, page: 3, pageSize: 2 });
    expect(page3.entries.map((e) => e.at)).toEqual(["2027-06-05T10:00:00.000Z"]);
    const page4 = await query({ actorId: admin.id, page: 4, pageSize: 2 });
    expect(page4).toMatchObject({ entries: [], total: 5 });
  });

  it("admin 33: autor de conta excluída aparece sem apelido", async () => {
    const gone = await createAccount(database.db, { role: "admin", status: "deleted" });
    await recordAt("2027-06-06T10:00:00Z", gone.id, "season.create");
    const res = await query({ actorId: gone.id });
    expect(res.entries.map((e) => e.actor)).toEqual([{ id: gone.id, nickname: null }]);
  });
});
