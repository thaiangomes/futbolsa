import "reflect-metadata";
import net from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { meResponseSchema, readNoticeResponseSchema, type NoticeBody } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { playerNotices, users } from "../../src/infra/db/schema/index.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { MAX_MAIL_ATTEMPTS, NoticesService } from "../../src/modules/accounts/notices.service.js";
import { LogMailer, Mailer, parseSmtpUrl, sendSmtp } from "../../src/infra/mail/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

// F14, T26: avisos ao jogador, e-mail da fila e o cliente SMTP (Admin 43).

const BODY: NoticeBody = {
  reason: "preços combinados no SPT3",
  trades: [{ at: "2027-03-20T15:00:00.000Z", ticker: "SPT3", quantity: 1, price: 770, value: 770 }],
};

describe("avisos ao jogador", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let notices: NoticesService;
  let mailer: LogMailer;

  const give = (userId: string, kind: "fraud_warning" | "fraud_ban" = "fraud_warning") =>
    withTransaction(database.db, (tx) => notices.create(tx, { userId, kind, body: BODY, at: clock.now() }));
  const me = async (token: string) => {
    const res = await app.inject({ method: "GET", url: "/me", headers: bearer(token) });
    expect(res.statusCode, res.body).toBe(200);
    return meResponseSchema.parse(res.json());
  };

  beforeAll(async () => {
    await seedSeason(database.db, 2027);
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    notices = app.get(NoticesService);
    mailer = app.get(Mailer) as LogMailer;
  });
  afterAll(() => app?.close());

  it("admin 43: o jogador vê o aviso pendente em GET /me até confirmar, com os negócios e sem a outra conta", async () => {
    const ana = await createAccount(database.db, { nickname: "Ana" });
    const id = await give(ana.id);
    const view = await me(ana.token);
    if (!view.registered) throw new Error("esperava conta");
    expect(view.pendingNotices).toHaveLength(1);
    expect(view.pendingNotices[0]).toMatchObject({ id, kind: "fraud_warning", body: BODY });
    expect(JSON.stringify(view.pendingNotices)).not.toMatch(/Bruno/);

    const read = await app.inject({ method: "POST", url: `/me/notices/${id}/read`, headers: bearer(ana.token) });
    expect(read.statusCode, read.body).toBe(200);
    const first = readNoticeResponseSchema.parse(read.json());
    const again = await app.inject({ method: "POST", url: `/me/notices/${id}/read`, headers: bearer(ana.token) });
    expect(readNoticeResponseSchema.parse(again.json())).toEqual(first);
    const after = await me(ana.token);
    expect(after.registered && after.pendingNotices).toEqual([]);
  });

  it("admin 43: só o dono confirma (notice_not_found)", async () => {
    const ana = await createAccount(database.db);
    const bruno = await createAccount(database.db);
    const id = await give(ana.id);
    const res = await app.inject({ method: "POST", url: `/me/notices/${id}/read`, headers: bearer(bruno.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("notice_not_found");
    const view = await me(ana.token);
    expect(view.registered && view.pendingNotices).toHaveLength(1);
  });

  it("admin 43: o bloqueado também vê o aviso", async () => {
    const blocked = await createAccount(database.db, { status: "blocked" });
    await give(blocked.id, "fraud_ban");
    const view = await me(blocked.token);
    expect(view.registered && view.pendingNotices.map((n) => n.kind)).toEqual(["fraud_ban"]);
  });

  it("admin 43: o e-mail sai depois do COMMIT; confirmação desfeita não envia; envia uma vez só", async () => {
    const ana = await createAccount(database.db);
    mailer.outbox.length = 0;
    await expect(
      withTransaction(database.db, async (tx) => {
        await notices.create(tx, { userId: ana.id, kind: "fraud_warning", body: BODY, at: clock.now() });
        throw new Error("desfaz");
      }),
    ).rejects.toThrow("desfaz");
    await notices.sendQueued();
    expect(mailer.outbox.filter((m) => m.to === ana.email)).toEqual([]);

    await give(ana.id);
    await notices.sendQueued();
    const mails = mailer.outbox.filter((m) => m.to === ana.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("SPT3");
    expect(mails[0]!.text).toContain("preços combinados");
    expect(mails[0]!.text).not.toMatch(/Bruno/);
    await notices.sendQueued();
    expect(mailer.outbox.filter((m) => m.to === ana.email)).toHaveLength(1);
  });

  it("admin 43: SMTP fora do ar tenta de novo e para em 5", async () => {
    const ana = await createAccount(database.db);
    const id = await give(ana.id);
    const spy = vi.spyOn(mailer, "send").mockRejectedValue(new Error("fora do ar"));
    for (let i = 0; i < MAX_MAIL_ATTEMPTS + 2; i++) await notices.sendQueued();
    const calls = spy.mock.calls.filter(([m]) => m.to === ana.email).length;
    spy.mockRestore();
    expect(calls).toBe(MAX_MAIL_ATTEMPTS);
    const [row] = await database.db.select().from(playerNotices).where(eq(playerNotices.id, id));
    expect(row).toMatchObject({ emailAttempts: MAX_MAIL_ATTEMPTS, emailSentAt: null });
    // o aviso na entrada continua valendo
    const view = await me(ana.token);
    expect(view.registered && view.pendingNotices).toHaveLength(1);
  });

  it("admin 43: conta excluída não recebe e os avisos somem com ela", async () => {
    const ana = await createAccount(database.db);
    await give(ana.id);
    await app.get(AccountDeletionService).deleteAccount(ana.id);
    mailer.outbox.length = 0;
    await notices.sendQueued();
    expect(mailer.outbox).toEqual([]);
    expect(await database.db.select().from(playerNotices).where(eq(playerNotices.userId, ana.id))).toEqual([]);
    const [u] = await database.db.select().from(users).where(eq(users.id, ana.id));
    expect(u!.status).toBe("deleted");
  });

  it("o corpo do aviso só aceita os campos do contrato (nada de outra conta)", async () => {
    const ana = await createAccount(database.db);
    await expect(give(ana.id).then(() => withTransaction(database.db, (tx) => notices.create(tx, { userId: ana.id, kind: "fraud_warning", body: { ...BODY, counterparty: "Bruno" } as never, at: clock.now() })))).rejects.toThrow();
  });

  it("o LogMailer não põe endereço nem texto no log", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    await new LogMailer().send({ to: "segredo@exemplo.com", subject: "assunto", text: "corpo secreto" });
    spy.mockRestore();
    expect(lines.join("")).not.toMatch(/segredo|corpo secreto/);
  });
});

describe("cliente SMTP", () => {
  /** Um servidor SMTP falso (sem TLS) que guarda o que recebeu e responde como um servidor de verdade. */
  function fakeServer(options: { rejectRcpt?: boolean } = {}) {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.setEncoding("utf8");
      socket.write("220 fake ESMTP\r\n");
      let data = false;
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (data) {
            if (line === ".") {
              data = false;
              socket.write("250 ok\r\n");
            } else received.push(line);
            continue;
          }
          received.push(line);
          if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH PLAIN")) socket.write("235 ok\r\n");
          else if (line.startsWith("RCPT")) socket.write(options.rejectRcpt ? "550 no\r\n" : "250 ok\r\n");
          else if (line === "DATA") {
            data = true;
            socket.write("354 go\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
    });
    return new Promise<{ port: number; received: string[]; close: () => void }>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => server.close() })),
    );
  }

  it("entrega uma mensagem em UTF-8 com autenticação", async () => {
    const s = await fakeServer();
    try {
      const settings = parseSmtpUrl(`smtp://usuario:senha@127.0.0.1:${s.port}`, "FutBolsa <jogo@exemplo.com>");
      await sendSmtp(settings, { to: "ana@exemplo.com", subject: "Negócios anulados", text: "ação\nlinha dois" });
      expect(s.received).toContain("MAIL FROM:<jogo@exemplo.com>");
      expect(s.received).toContain("RCPT TO:<ana@exemplo.com>");
      const base64 = s.received.slice(s.received.findIndex((l) => l === "") + 1).join("");
      expect(Buffer.from(base64, "base64").toString("utf8")).toBe("ação\nlinha dois");
    } finally {
      s.close();
    }
  });

  it("a recusa do servidor vira erro sem o endereço nem a senha", async () => {
    const s = await fakeServer({ rejectRcpt: true });
    try {
      const settings = parseSmtpUrl(`smtp://usuario:senha@127.0.0.1:${s.port}`, "jogo@exemplo.com");
      const error = await sendSmtp(settings, { to: "ana@exemplo.com", subject: "x", text: "y" }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(/ana@|senha/);
    } finally {
      s.close();
    }
  });

  it("recusa uma SMTP_URL fora do formato", () => {
    expect(() => parseSmtpUrl("http://x", "a@b.c")).toThrow();
    expect(() => parseSmtpUrl("lixo", "a@b.c")).toThrow();
    expect(parseSmtpUrl("smtps://u:p@smtp.exemplo.com", "a@b.c")).toMatchObject({ port: 465, secure: true });
  });
});
