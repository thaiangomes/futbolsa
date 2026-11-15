import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { finishTime } from "@futbolsa/engine";
import { bots as botsTabela, ipoBids, orders, payoutEvents, seasonClubs, seasons, users, wallets } from "../../src/infra/db/schema/index.js";
import { apagarBanco } from "../../partida/banco.js";
import { subirPartida, type Partida } from "../../partida/partida.js";
import { MARGEM_DO_FECHAMENTO } from "../../partida/relogio.js";
import { createTestApp } from "../support/app.js";
import { testDatabaseUrl } from "../support/db.js";
import { createAccount } from "../support/accounts.js";
import { bearer } from "../support/auth.js";
import { createTestDatabase } from "../support/db.js";
import { withTestAuth } from "../support/auth.js";
import { FixedClock } from "../../src/infra/clock/index.js";

// F17, T5 e T6: a partida de verdade (API inteira, banco, bots, condutor) sem as portas HTTP do site e do terminal.
const nome = `futbolsa_partida_t${randomBytes(3).toString("hex")}`;
const partidas: Partida[] = [];
let real = 5_000_000;

async function subir(extra: Partial<Parameters<typeof subirPartida>[0]> = {}): Promise<Partida> {
  const p = await subirPartida({ urlBanco: testDatabaseUrl(), pastaDoSite: "inexistente", escala: 0.2, portaApi: 0, portaSite: 0, semPortas: true, laco: false, nomeDoBanco: nome, agoraReal: () => real, ...extra });
  partidas.push(p);
  return p;
}

afterAll(async () => {
  for (const p of partidas.splice(0)) await p.fechar().catch(() => undefined);
  await apagarBanco(testDatabaseUrl(), nome);
});

const post = async (p: Partida, corpo: object, auth: Promise<{ authorization: string }> | { authorization: string } | undefined) =>
  p.servidor.app.inject({ method: "POST", url: "/admin/partida/relogio", payload: corpo, headers: await auth });

describe("a partida de teste", () => {
  let p: Partida;
  let instanteInicial: Date;

  it("2, 11: temporada 2026 em preparação com os clubes de 2026, IPO aberto no instante inicial; jogador com R$ 100.000,00 e admin sem carteira", async () => {
    p = await subir();
    instanteInicial = p.clock.now();
    expect(p.nova).toBe(true);
    const db = p.servidor.conexao.db;
    const [temporada] = await db.select().from(seasons).where(eq(seasons.id, p.carga.seasonId));
    expect(temporada).toMatchObject({ year: 2026, status: "ipo_open" });
    expect(instanteInicial.getTime()).toBe(p.carga.ipo.opensAt.getTime());
    const clubes = await db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, p.carga.seasonId));
    expect(clubes).toHaveLength(20);
    expect(p.carga.tickers).toEqual(expect.arrayContaining(["CAP3", "CHA3", "CFC3", "REM3", "FLA3"]));
    expect(clubes.find((c) => c.clubId === p.carga.clubIds.get("FLA3"))?.prevPlacement).toBe(1); // a tabela final de 2025
    expect(clubes.find((c) => c.clubId === p.carga.clubIds.get("REM3"))?.prevPlacement).toBe(20);
    const carteiras = await db.select().from(wallets);
    const doJogador = carteiras.filter((w) => w.userId === p.jogador!.conta.id);
    expect(doJogador).toHaveLength(1);
    expect(Number(doJogador[0]!.cash)).toBe(10_000_000);
    expect(carteiras.some((w) => w.userId === p.carga.admin.conta.id)).toBe(false);
    expect((await db.select().from(users).where(eq(users.id, p.carga.admin.conta.id)))[0]!.role).toBe("admin");
    expect((await db.select().from(users).where(eq(users.id, p.jogador!.conta.id)))[0]!.role).toBe("player");
    // o jogador aparece nos rankings; o admin não
    const ranking = await p.servidor.app.inject({ method: "GET", url: "/rankings/live" });
    expect(ranking.statusCode).toBe(200);
    expect(ranking.body).toContain("jogador");
    expect(ranking.body).not.toContain("admin_partida");
  });

  it("3: com o relógio parado, o jogador manda oferta e lê o IPO e o relógio não se mexe", async () => {
    const auth = await p.jogador!.auth();
    const painel = await p.servidor.app.inject({ method: "GET", url: "/ipo", headers: auth });
    expect(painel.statusCode).toBe(200);
    const clube = (painel.json() as { clubs: Array<{ ticker: string; band?: { ceiling: number } | null }> }).clubs[0]!;
    const oferta = await p.servidor.app.inject({ method: "PUT", url: `/ipo/bids/${clube.ticker}`, payload: { quantity: 10, maxPrice: clube.band?.ceiling ?? 500, expect: "new" }, headers: await p.jogador!.auth() });
    expect(oferta.statusCode).toBeLessThan(300);
    expect(p.clock.now().getTime()).toBe(instanteInicial.getTime());
    expect(p.relogio.estado().modo).toBe("pausado");
  });

  it("12: jogador comum e visitante não mexem no relógio (403 e 401); o admin lê o estado", async () => {
    expect((await post(p, { acao: "dia" }, p.jogador!.auth())).statusCode).toBe(403);
    expect((await post(p, { acao: "dia" }, undefined)).statusCode).toBe(401);
    expect((await p.servidor.app.inject({ method: "GET", url: "/admin/partida", headers: await p.jogador!.auth() })).statusCode).toBe(403);
    const estado = await p.servidor.app.inject({ method: "GET", url: "/admin/partida", headers: await p.carga.admin.auth() });
    expect(estado.statusCode).toBe(200);
    expect(estado.json()).toMatchObject({ partida: true, relogio: { modo: "pausado" } });
    expect((await post(p, { acao: "tuuudo" }, p.carga.admin.auth())).statusCode).toBe(400);
    expect(p.clock.now().getTime()).toBe(instanteInicial.getTime());
  });

  it("15, 5, 10: até a próxima rodada com os 9 perfis jogando; dois pedidos juntos (um anda, o outro é recusado)", async () => {
    const db = p.servidor.conexao.db;
    const longo = post(p, { acao: "rodada" }, p.carga.admin.auth());
    await new Promise((ok) => setTimeout(ok, 500));
    const concorrente = await post(p, { acao: "dia" }, p.carga.admin.auth());
    expect(concorrente.statusCode).toBe(409);
    expect(concorrente.json()).toMatchObject({ code: "relogio_ocupado", message: "o relógio já está andando" });
    const r = await longo;
    expect(r.statusCode).toBe(200);
    // para quando termina o último jogo da primeira rodada do Brasileirão (fora os adiados)
    const fonte = p.servidor.fonte;
    const jogos = fonte.matchesOf("brasileirao-a").filter((m) => m.round === 1 && !m.postponed);
    const fim = Math.max(...jogos.map(finishTime));
    expect(p.clock.now().getTime()).toBe(fim + MARGEM_DO_FECHAMENTO);
    // o fechamento dela já rodou; a aprovação do pagamento continua sendo um passo do admin
    const eventos = await db.select().from(payoutEvents).where(eq(payoutEvents.seasonId, p.carga.seasonId));
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.every((e) => e.status === "pending")).toBe(true);
    // cada um dos 9 perfis colocou ordem ou oferta pelas mesmas rotas
    const ativos = await db
      .select({ profile: botsTabela.profile })
      .from(botsTabela)
      .innerJoin(wallets, eq(wallets.botId, botsTabela.id))
      .innerJoin(orders, eq(orders.walletId, wallets.id));
    const ofertas = await db
      .select({ profile: botsTabela.profile })
      .from(botsTabela)
      .innerJoin(wallets, eq(wallets.botId, botsTabela.id))
      .innerJoin(ipoBids, eq(ipoBids.walletId, wallets.id));
    const perfis = new Set([...ativos, ...ofertas].map((l) => l.profile));
    expect(perfis.size, `perfis que jogaram: ${[...perfis].join(", ")}`).toBe(9);
  }, 900_000);

  it("19: em tempo real, 10 minutos de verdade são 10 minutos do jogo; as paradas rodam e os bots agem; pausar para no instante", async () => {
    const antes = p.clock.now().getTime();
    const paradasAntes = p.condutor.paradas;
    const rodadasAntes = p.bots.resumo.rodadas;
    await p.relogio.pedir({ acao: "tempo-real" });
    real += 10 * 60_000;
    expect(Math.abs(p.clock.now().getTime() - (antes + 10 * 60_000))).toBeLessThanOrEqual(60_000);
    real += 20 * 60_000; // passou ao menos uma parada da grade de 15 minutos
    await p.relogio.tique();
    expect(p.condutor.paradas).toBeGreaterThan(paradasAntes);
    expect(p.bots.resumo.rodadas).toBeGreaterThan(rodadasAntes);
    const r = await p.relogio.pedir({ acao: "pausar" });
    const parado = p.clock.now().getTime();
    real += 3_600_000;
    expect(p.clock.now().getTime()).toBe(parado);
    expect(r.estado.modo).toBe("pausado");
  }, 300_000);

  it("16: desligada e ligada de novo, a partida volta ao mesmo instante, pausada, com as mesmas contas, carteiras e bots", async () => {
    const instante = p.clock.now().getTime();
    const contas = async (x: Partida) => (await x.servidor.conexao.db.select({ id: users.id, nickname: users.nickname }).from(users)).map((u) => u.nickname).sort();
    const carteiras = async (x: Partida) => Number((await x.servidor.conexao.db.execute<{ n: string }>(sql`select count(*)::text as n from futbolsa.wallets`)).rows[0]!.n);
    const botsAtivos = async (x: Partida) => (await x.servidor.conexao.db.select().from(botsTabela).where(eq(botsTabela.active, true))).length;
    const antes = { contas: await contas(p), carteiras: await carteiras(p), bots: await botsAtivos(p) };
    await p.fechar();
    partidas.splice(partidas.indexOf(p), 1);
    const q = await subir();
    expect(q.nova).toBe(false);
    expect(q.clock.now().getTime()).toBe(instante);
    expect(q.relogio.estado().modo).toBe("pausado");
    expect({ contas: await contas(q), carteiras: await carteiras(q), bots: await botsAtivos(q) }).toEqual(antes);
    expect(q.carga.seasonId).toBe(p.carga.seasonId);
    // o jogador de antes entra de novo (o token é novo, a conta é a mesma)
    const eu = await q.servidor.app.inject({ method: "GET", url: "/me", headers: await q.jogador!.auth() });
    expect(eu.statusCode).toBe(200);
    expect(eu.json()).toMatchObject({ nickname: "jogador" });
    p = q;
  }, 300_000);

  it("16: zerar apaga tudo e a partida recomeça no instante inicial", async () => {
    await p.fechar();
    partidas.splice(partidas.indexOf(p), 1);
    await apagarBanco(testDatabaseUrl(), nome);
    const nova = await subir();
    expect(nova.nova).toBe(true);
    expect(nova.clock.now().getTime()).toBe(instanteInicial.getTime());
    p = nova;
  }, 300_000);
});

describe("a API do jogo público", () => {
  it("13: sem o módulo da partida a rota do relógio não existe (404), com qualquer variável de ambiente", async () => {
    const banco = await createTestDatabase(5);
    const clock = new FixedClock(new Date("2026-03-01T12:00:00Z"));
    process.env.PARTIDA = "1";
    process.env.MODO_PARTIDA = "true";
    process.env.RELOGIO_MANUAL = "1";
    const app = await createTestApp({ db: banco.db, clock, override: (b) => withTestAuth(clock)(b) });
    try {
      const admin = await createAccount(banco.db, { role: "admin", at: clock.now() });
      const headers = bearer(await admin.tokenWith({ at: clock.now() }));
      expect((await app.inject({ method: "POST", url: "/admin/partida/relogio", payload: { acao: "dia" }, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/admin/partida", headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/partida/hora" })).statusCode).toBe(404);
    } finally {
      delete process.env.PARTIDA;
      delete process.env.MODO_PARTIDA;
      delete process.env.RELOGIO_MANUAL;
      await app.close();
      await banco.close();
    }
  });
});
