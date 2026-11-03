import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { adminLog } from "../../src/infra/db/schema/index.js";
import { AdminLogService } from "../../src/modules/admin/log/index.js";
import { createAccount } from "../support/accounts.js";
import { useTestDatabase } from "../support/db.js";

describe("registro do admin (record)", () => {
  const database = useTestDatabase(5);
  const clock = new FixedClock(new Date("2027-05-20T15:00:00Z"));
  const log = new AdminLogService(clock);

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
    const rows = await database.db.select().from(adminLog).where(eq(adminLog.actorId, admin.id));
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
    expect(await database.db.select().from(adminLog).where(eq(adminLog.actorId, admin.id))).toHaveLength(0);
  });
});
