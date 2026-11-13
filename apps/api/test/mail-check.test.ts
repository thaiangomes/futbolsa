import net from "node:net";
import { describe, expect, it } from "vitest";
import { runMailCheck } from "../src/infra/mail/check.js";

// Conferência do envio de e-mail (npm run mail:check): sem credencial real, contra um servidor SMTP falso local.

describe("mail:check", () => {
  it("pede o destinatário e a SMTP_URL, sem repetir segredo", async () => {
    await expect(runMailCheck({ SMTP_URL: "smtp://u:s@h:587" }, undefined)).rejects.toThrow(/destinatário/);
    await expect(runMailCheck({ SMTP_URL: "smtp://u:s@h:587" }, "lixo")).rejects.toThrow(/destinatário/);
    await expect(runMailCheck({}, "a@b.co")).rejects.toThrow(/SMTP_URL/);
  });

  it("manda o e-mail de teste pelo servidor e responde sem URL nem senha", async () => {
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.setEncoding("utf8");
      socket.write("220 fake\r\n");
      let data = false;
      let buf = "";
      socket.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (data) {
            if (line === ".") {
              data = false;
              socket.write("250 ok\r\n");
            }
            continue;
          }
          seen.push(line);
          if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH")) socket.write("235 ok\r\n");
          else if (line === "DATA") {
            data = true;
            socket.write("354 go\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const out = await runMailCheck({ SMTP_URL: `smtp://usuario:segredo@127.0.0.1:${port}`, MAIL_FROM: "FutBolsa <jogo@exemplo.com>" }, "ana@exemplo.com");
      expect(out).toContain("enviado");
      expect(out).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
      expect(seen).toContain("RCPT TO:<ana@exemplo.com>");
    } finally {
      server.close();
    }
  });
});
