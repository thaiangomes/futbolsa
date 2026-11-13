import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

/**
 * Um cliente SMTP mínimo, sem biblioteca (T26 da F14): conecta, negocia (`STARTTLS` ou TLS direto), autentica com
 * `AUTH PLAIN` ou `AUTH LOGIN` e entrega **uma** mensagem de texto em UTF-8. Basta para o aviso de trapaça por Gmail
 * (senha de app) ou Resend. As mensagens de erro nunca levam o usuário, a senha nem o endereço de destino.
 */
export interface SmtpSettings {
  host: string;
  port: number;
  /** TLS direto na conexão (`smtps://`, porta 465). Sem isso, `STARTTLS` se o servidor oferecer. */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** `Nome <endereço>` ou só o endereço. */
  from: string;
  /** Tempo máximo de cada resposta (ms). */
  timeoutMs: number;
  /** Só para teste local com certificado próprio. */
  rejectUnauthorized: boolean;
}

export function parseSmtpUrl(url: string, from: string): SmtpSettings {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("SMTP_URL inválida: use smtp://usuario:senha@servidor:587 ou smtps://usuario:senha@servidor:465");
  }
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("SMTP_URL deve começar com smtp:// ou smtps://");
  const secure = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    secure,
    user: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
    from,
    timeoutMs: 15_000,
    rejectUnauthorized: u.searchParams.get("insecure") !== "1",
  };
}

interface Reply {
  code: number;
  lines: string[];
}

/** Lê as respostas do servidor linha a linha (uma resposta pode ter várias linhas `250-…`, a última `250 …`). */
class Connection {
  private buffer = "";
  private readonly waiting: Array<(r: Reply | Error) => void> = [];
  private readonly replies: Array<Reply | Error> = [];
  private partial: string[] = [];

  constructor(
    private socket: net.Socket | tls.TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.push(err));
    socket.on("close", () => this.push(new Error("conexão SMTP fechada pelo servidor")));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + 1);
      this.partial.push(line);
      // resposta completa: "NNN texto" (com espaço depois do código); "NNN-texto" continua
      if (/^\d{3}( |$)/.test(line)) {
        this.push({ code: Number(line.slice(0, 3)), lines: this.partial });
        this.partial = [];
      }
    }
  }

  private push(item: Reply | Error): void {
    const next = this.waiting.shift();
    if (next) next(item);
    else this.replies.push(item);
  }

  reply(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("o servidor SMTP não respondeu a tempo")), this.timeoutMs);
      const done = (item: Reply | Error) => {
        clearTimeout(timer);
        if (item instanceof Error) reject(item);
        else resolve(item);
      };
      const ready = this.replies.shift();
      if (ready) done(ready);
      else this.waiting.push(done);
    });
  }

  write(text: string): void {
    this.socket.write(text);
  }

  async command(text: string, ...ok: number[]): Promise<Reply> {
    this.write(`${text}\r\n`);
    return this.expect(ok);
  }

  async expect(ok: number[]): Promise<Reply> {
    const reply = await this.reply();
    if (!ok.includes(reply.code)) throw new Error(`o servidor SMTP recusou (${reply.code})`);
    return reply;
  }

  /** Troca a conexão pura por TLS (depois do `STARTTLS`). */
  upgrade(host: string, rejectUnauthorized: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.removeAllListeners("data");
      this.socket.removeAllListeners("error");
      this.socket.removeAllListeners("close");
      const secured = tls.connect({ socket: this.socket, servername: host, rejectUnauthorized }, () => resolve());
      secured.once("error", reject);
      this.socket = secured;
      this.buffer = "";
      this.partial = [];
      this.attach(secured);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** O cabeçalho com acento vai em base64 (RFC 2047); só ASCII passa direto. */
function headerText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function chunk76(base64: string): string {
  return base64.replace(/(.{76})/g, "$1\r\n");
}

/** O endereço puro de `Nome <endereço>`. */
function addressOf(value: string): string {
  const m = /<([^<>\s]+)>/.exec(value);
  return (m ? m[1]! : value).trim();
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
}

export async function sendSmtp(settings: SmtpSettings, message: SmtpMessage): Promise<void> {
  if (/[\r\n]/.test(message.to) || /[\r\n]/.test(message.subject)) throw new Error("cabeçalho de e-mail inválido");
  const socket: net.Socket = await new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(new Error(`não conectou ao servidor SMTP (${(e as NodeJS.ErrnoException).code ?? "erro"})`));
    const s: net.Socket = settings.secure
      ? tls.connect({ host: settings.host, port: settings.port, servername: settings.host, rejectUnauthorized: settings.rejectUnauthorized }, () => resolve(s))
      : net.connect({ host: settings.host, port: settings.port }, () => resolve(s));
    s.once("error", onError);
  });
  const conn = new Connection(socket, settings.timeoutMs);
  try {
    await conn.expect([220]);
    let ehlo = await conn.command("EHLO futbolsa.local", 250);
    if (!settings.secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await conn.command("STARTTLS", 220);
      await conn.upgrade(settings.host, settings.rejectUnauthorized);
      ehlo = await conn.command("EHLO futbolsa.local", 250);
    }
    if (settings.user !== null && settings.password !== null) {
      const plain = Buffer.from(`\0${settings.user}\0${settings.password}`, "utf8").toString("base64");
      if (ehlo.lines.some((l) => /AUTH[ =].*PLAIN/i.test(l))) {
        await conn.command(`AUTH PLAIN ${plain}`, 235);
      } else {
        await conn.command("AUTH LOGIN", 334);
        await conn.command(Buffer.from(settings.user, "utf8").toString("base64"), 334);
        await conn.command(Buffer.from(settings.password, "utf8").toString("base64"), 235);
      }
    }
    await conn.command(`MAIL FROM:<${addressOf(settings.from)}>`, 250);
    await conn.command(`RCPT TO:<${addressOf(message.to)}>`, 250, 251);
    await conn.command("DATA", 354);
    const body = [
      `From: ${headerText(settings.from)}`,
      `To: ${message.to}`,
      `Subject: ${headerText(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@futbolsa.local>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      chunk76(Buffer.from(message.text, "utf8").toString("base64")),
    ].join("\r\n");
    // base64 não tem linha começando com ponto: não precisa duplicar o ponto
    conn.write(`${body}\r\n.\r\n`);
    await conn.expect([250]);
    conn.write("QUIT\r\n");
  } finally {
    conn.close();
  }
}
