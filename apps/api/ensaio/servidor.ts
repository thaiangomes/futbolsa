import "reflect-metadata";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FixedClock } from "../src/infra/clock/index.js";
import { connect, type DbConnection } from "../src/infra/db/client.js";
import { createTestApp } from "../test/support/app.js";
import { withTestAuth } from "../test/support/auth.js";
import { BotRunnerSettings } from "../src/modules/admin/bots/runner.js";
import { ResultSourceRegistry } from "../src/modules/admin/results/sources/registry.js";
import { ReplaySource } from "./replay-source.js";
import { recusarBancoNaoLocal, recusarProducao } from "./guardas.js";

/**
 * Fábrica do app de teste (P1): monta a API inteira, como em produção, com o relógio fixo e o
 * verificador de login de chaves de teste trocados pelo módulo de testes do Nest. Nada aqui é lido
 * por `src/`, e nenhuma variável de ambiente liga "login falso" na API de verdade.
 */
export interface ServidorEnsaio {
  app: NestFastifyApplication;
  clock: FixedClock;
  /** A fonte de resultados de reprodução que a API usa no lugar da ESPN e da football-data.org. */
  fonte: ReplaySource;
  conexao: DbConnection;
  /** Endereço HTTP da API (`http://127.0.0.1:porta`). */
  url: string;
  /** Derruba só o app (a queda da API do ensaio): o banco e o relógio continuam. */
  derrubar(): Promise<void>;
  /** Sobe outro app no mesmo banco e no mesmo relógio. */
  subir(): Promise<void>;
  fechar(): Promise<void>;
}

export interface OpcoesServidor {
  databaseUrl: string;
  inicio: Date;
  poolSize?: number;
  /** Ritmo dos bots (P12): padrão do ensaio comparável, a cada 180 minutos com chance 0,25. */
  bots?: { tickMinutes: number; activityPer3h: number };
}

export async function criarServidorEnsaio(opcoes: OpcoesServidor): Promise<ServidorEnsaio> {
  recusarProducao();
  recusarBancoNaoLocal(opcoes.databaseUrl);
  const clock = new FixedClock(opcoes.inicio);
  const conexao = connect(opcoes.databaseUrl, opcoes.poolSize ?? 20);
  const fonte = new ReplaySource(() => clock.now());
  const servidor = { clock, conexao, fonte } as ServidorEnsaio;
  const ritmo = opcoes.bots ?? { tickMinutes: 180, activityPer3h: 0.25 };
  let app: NestFastifyApplication | undefined;

  servidor.subir = async () => {
    app = await createTestApp({
      db: conexao.db,
      clock,
      override: (b) =>
        withTestAuth(clock)(b)
          .overrideProvider(ResultSourceRegistry)
          .useValue(new ResultSourceRegistry(() => fonte))
          .overrideProvider(BotRunnerSettings)
          .useValue({ config: ritmo }),
    });
    await app.listen(0, "127.0.0.1");
    servidor.app = app;
    servidor.url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  };
  servidor.derrubar = async () => {
    await app?.close();
    app = undefined;
  };
  servidor.fechar = async () => {
    await servidor.derrubar();
    await conexao.close();
  };
  await servidor.subir();
  return servidor;
}

/** Um cenário que o navegador ou o ensaio pede pela porta de controle (`POST /cenario/<nome>`). */
export type Cenario = (corpo: unknown) => Promise<unknown>;

/**
 * Porta de controle: separada da API, só no endereço local, para o Playwright e a carga darem a
 * hora, avançarem o relógio e prepararem cenários. Nunca é montada pela API de verdade.
 */
export async function abrirControle(
  servidor: Pick<ServidorEnsaio, "clock" | "derrubar" | "subir">,
  cenarios: Record<string, Cenario> = {},
  porta = 0,
): Promise<{ url: string; fechar(): Promise<void> }> {
  const http: Server = createServer(async (req, res) => {
    const responder = (status: number, corpo: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(corpo));
    };
    try {
      const partes: Buffer[] = [];
      for await (const parte of req) partes.push(parte as Buffer);
      const texto = Buffer.concat(partes).toString("utf8");
      const corpo = texto ? JSON.parse(texto) : {};
      const rota = `${req.method} ${req.url}`;
      if (rota === "GET /hora") return responder(200, { agora: servidor.clock.now().toISOString() });
      if (rota === "POST /avancar") {
        if (typeof corpo.ms === "number") servidor.clock.advance(corpo.ms);
        else if (typeof corpo.para === "string") servidor.clock.set(new Date(corpo.para));
        else return responder(400, { erro: "mande { ms } ou { para }" });
        return responder(200, { agora: servidor.clock.now().toISOString() });
      }
      if (rota === "POST /derrubar") {
        await servidor.derrubar();
        return responder(200, {});
      }
      if (rota === "POST /subir") {
        await servidor.subir();
        return responder(200, {});
      }
      const nome = /^POST \/cenario\/([\w-]+)$/.exec(rota)?.[1];
      const cenario = nome ? cenarios[nome] : undefined;
      if (cenario) return responder(200, (await cenario(corpo)) ?? {});
      return responder(404, { erro: "rota desconhecida" });
    } catch (error) {
      responder(500, { erro: (error as Error).message });
    }
  });
  await new Promise<void>((ok) => http.listen(porta, "127.0.0.1", ok));
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, fechar: () => new Promise((ok) => http.close(() => ok())) };
}
