import "reflect-metadata";
import { performance } from "node:perf_hooks";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FixedClock } from "../src/infra/clock/index.js";
import { connect, type DbConnection } from "../src/infra/db/client.js";
import { eq } from "drizzle-orm";
import { clubs, seasonClubs } from "../src/infra/db/schema/index.js";
import { setMetrics } from "../src/infra/db/metrics.js";
import { BotRunner, BotRunnerSettings } from "../src/modules/admin/bots/runner.js";
import { FairValueService } from "../src/modules/market/maker/fair-value.service.js";
import { RefreshJob } from "../src/modules/market/maker/refresh.job.js";
import { abrirControle, type Cenario } from "../ensaio/servidor.js";
import { recusarBancoNaoLocal, recusarProducao } from "../ensaio/guardas.js";
import { createTestApp } from "../test/support/app.js";
import { createAccount } from "../test/support/accounts.js";
import { tokenFor, withTestAuth } from "../test/support/auth.js";
import { MedidoresHistograma } from "./medidores.js";

/**
 * O servidor da carga (T16): a API inteira, como em produção, num processo só dela, com o relógio andando em tempo real,
 * os medidores da T15 ligados e uma porta de controle local para o gerador (tokens de teste, medidas, reposição da casa).
 * Nada daqui é lido por `src/`. O mesmo servidor serve aos cenários locais e ao CI; contra uma API de verdade (Azure) o
 * gerador só precisa de tokens e do banco, e isso não existe lá (veja `carga/README.md`).
 */

/** 2027-04-06 10:00 em Brasília: terça-feira, dentro do pregão, com a negociação já aberta pela fixture de mercado. */
export const INICIO_DA_CARGA = new Date("2027-04-06T13:00:00Z");

/** Relógio que anda sozinho, na velocidade real, a partir de um instante simulado (sem sorteio nem atraso de ticker). */
export class RelogioDeCarga extends FixedClock {
  private readonly realInicio = Date.now();
  constructor(private readonly base: Date) {
    super(base);
  }
  override now(): Date {
    return new Date(this.base.getTime() + (Date.now() - this.realInicio));
  }
  /** Quantos ms o relógio simulado está à frente do `Date.now()` (constante). */
  get deslocamento(): number {
    return this.base.getTime() - this.realInicio;
  }
}

export interface OpcoesServidorCarga {
  databaseUrl: string;
  poolSize?: number;
  /** Preço do valor justo de todos os clubes (centavos); a casa cota ao redor dele. Padrão R$ 40,00. */
  valorJusto?: number;
  /** Intervalo da reposição da casa em ms (a tarefa de 5 segundos do plano). Padrão 5000. */
  reposicaoMs?: number;
}

export interface ServidorCarga {
  apiUrl: string;
  controleUrl: string;
  clock: RelogioDeCarga;
  conexao: DbConnection;
  medidores: MedidoresHistograma;
  app(): NestFastifyApplication;
  derrubar(): Promise<void>;
  subir(): Promise<void>;
  fechar(): Promise<void>;
}

export async function subirServidorDeCarga(opcoes: OpcoesServidorCarga): Promise<ServidorCarga> {
  process.env.WEB_ORIGIN ??= "http://localhost:3001";
  recusarProducao();
  recusarBancoNaoLocal(opcoes.databaseUrl);
  const clock = new RelogioDeCarga(INICIO_DA_CARGA);
  const conexao = connect(opcoes.databaseUrl, opcoes.poolSize ?? 20);
  const medidores = new MedidoresHistograma();
  setMetrics(medidores);
  let app: NestFastifyApplication | undefined;
  let reposicao: NodeJS.Timeout | undefined;
  const valorJusto = opcoes.valorJusto ?? 4000;
  // sem calendário importado o valor justo real não existe: a carga fixa um valor para todos, e a casa cota ao redor dele
  const valorJustoFixo = {
    compute: async (seasonId: number) => {
      const linhas = await conexao.db
        .select({ ticker: clubs.ticker })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(seasonClubs.seasonId, seasonId));
      return new Map(linhas.map((l) => [l.ticker!, valorJusto]));
    },
  };
  let seletorBots: { config: { tickMinutes: number; activityPer3h: number } } = { config: { tickMinutes: 15, activityPer3h: 0.25 } };

  const servidor = { clock, conexao, medidores } as ServidorCarga;
  servidor.app = () => app!;
  servidor.subir = async () => {
    app = await createTestApp({
      db: conexao.db,
      clock,
      override: (b) =>
        withTestAuth(clock)(b)
          .overrideProvider(FairValueService)
          .useValue(valorJustoFixo)
          .overrideProvider(BotRunnerSettings)
          .useValue({
            get config() {
              return seletorBots.config;
            },
          }),
    });
    await app.listen(0, "127.0.0.1");
    servidor.apiUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  };
  servidor.derrubar = async () => {
    await app?.close();
    app = undefined;
  };
  servidor.fechar = async () => {
    if (reposicao) clearInterval(reposicao);
    await servidor.derrubar();
    setMetrics(undefined);
    await conexao.close();
  };

  const cenarios: Record<string, Cenario> = {
    /** Tokens de teste de uma lista de identidades (`sub`), com a validade em segundos. */
    tokens: async (corpo) => {
      const { subjects, expiresIn = 12 * 3600 } = corpo as { subjects: string[]; expiresIn?: number };
      const at = clock.now();
      const tokens: Record<string, string> = {};
      for (const subject of subjects) tokens[subject] = await tokenFor({ subject, at, expiresIn });
      return { tokens };
    },
    medidas: async () => ({ medidas: medidores.relatorio() }),
    "reiniciar-medidas": async () => {
      medidores.reiniciar();
      return {};
    },
    /** A hora do servidor e o deslocamento do relógio em relação ao `Date.now()`, para o gerador medir o atraso dos eventos. */
    hora: async () => ({ agora: clock.now().toISOString(), deslocamentoMs: clock.deslocamento, apiUrl: servidor.apiUrl }),
    /** Uma passada da reposição da casa agora, ou, com `cadaMs`, de tempos em tempos (a tarefa de 5 segundos). */
    reposicao: async (corpo) => {
      const { cadaMs } = corpo as { cadaMs?: number };
      const passada = () => app!.get(RefreshJob, { strict: false }).runDue();
      if (cadaMs) {
        if (reposicao) clearInterval(reposicao);
        reposicao = setInterval(() => void passada().catch(() => undefined), cadaMs);
        return { cadaMs };
      }
      if (cadaMs === 0 && reposicao) clearInterval(reposicao);
      const t0 = performance.now();
      const relatorio = await passada();
      return { ms: performance.now() - t0, relatorio };
    },
    /** Liga os bots pelo admin (`PATCH /admin/bots`) e devolve o que a API respondeu. */
    "ligar-bots": async (corpo) => {
      const { counts } = corpo as { counts: Record<string, number> };
      const admin = await createAccount(conexao.db, { role: "admin" });
      const res = await app!.inject({ method: "PATCH", url: "/admin/bots", payload: { counts }, headers: { authorization: `Bearer ${admin.token}` } });
      return { status: res.statusCode, corpo: res.statusCode >= 300 ? res.body.slice(0, 500) : undefined };
    },
    /** Uma rodada da tarefa dos bots, cronometrada. `chance` (0 a 1) liga todos os bots com essa chance (padrão a da produção). */
    "rodada-bots": async (corpo) => {
      const { tickMinutes } = corpo as { tickMinutes?: number };
      if (tickMinutes) seletorBots = { config: { tickMinutes, activityPer3h: 0.25 } };
      const t0 = performance.now();
      const relatorio = await app!.get(BotRunner, { strict: false }).runOnce(clock.now());
      return { ms: performance.now() - t0, relatorio };
    },
    memoria: async () => ({ rssMb: Math.round(process.memoryUsage().rss / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576) }),
  };

  await servidor.subir();
  const controle = await abrirControle(servidor, cenarios);
  servidor.controleUrl = controle.url;
  const fecharBase = servidor.fechar;
  servidor.fechar = async () => {
    await controle.fechar();
    await fecharBase();
  };
  return servidor;
}
