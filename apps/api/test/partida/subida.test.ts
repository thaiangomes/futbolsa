import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { seasons, seasonClubs, wallets, bots as botsTabela, users } from "../../src/infra/db/schema/index.js";
import { apagarBanco } from "../../partida/banco.js";
import { subirPartida, type Partida } from "../../partida/partida.js";
import { testDatabaseUrl } from "../support/db.js";

// F17, T5: a partida sobe com a temporada de 2026 em preparação, o IPO aberto, os bots dos 9 perfis, a conta de jogador e a de admin.
const nome = `futbolsa_partida_t${randomBytes(3).toString("hex")}`;
const partidas: Partida[] = [];

async function subir(extra: Partial<Parameters<typeof subirPartida>[0]> = {}): Promise<Partida> {
  const p = await subirPartida({ urlBanco: testDatabaseUrl(), pastaDoSite: "inexistente", escala: 0.1, portaApi: 0, portaSite: 0, semPortas: true, laco: false, nomeDoBanco: nome, ...extra });
  partidas.push(p);
  return p;
}

afterAll(async () => {
  for (const p of partidas.splice(0)) await p.fechar().catch(() => undefined);
  await apagarBanco(testDatabaseUrl(), nome);
});

describe("subida da partida", () => {
  it("2, 11: temporada 2026 em preparação, IPO aberto no instante inicial, jogador com R$ 100.000,00 e admin sem carteira", async () => {
    const p = await subir();
    expect(p.nova).toBe(true);
    const db = p.servidor.conexao.db;
    const [temporada] = await db.select().from(seasons).where(eq(seasons.id, p.carga.seasonId));
    expect(temporada).toMatchObject({ year: 2026 });
    expect(temporada!.status).toBe("ipo_open");
    expect(p.clock.now().getTime()).toBe(p.carga.ipo.opensAt.getTime());
    // clubes de 2026, com a tabela final de 2025 nas colocações
    const clubes = await db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, p.carga.seasonId));
    expect(clubes).toHaveLength(20);
    expect(p.carga.tickers).toEqual(expect.arrayContaining(["CAP3", "CHA3", "CFC3", "REM3", "FLA3"]));
    expect(clubes.find((c) => c.clubId === p.carga.clubIds.get("FLA3"))?.prevPlacement).toBe(1);
    expect(clubes.find((c) => c.clubId === p.carga.clubIds.get("REM3"))?.prevPlacement).toBe(20);
    // jogador: R$ 100.000,00; admin: nenhuma carteira (PR 49)
    const carteiras = await db.select().from(wallets);
    const doJogador = carteiras.filter((w) => w.userId === p.jogador.conta.id);
    expect(doJogador).toHaveLength(1);
    expect(Number(doJogador[0]!.cash)).toBe(10_000_000);
    expect(carteiras.some((w) => w.userId === p.carga.admin.conta.id)).toBe(false);
    const [admin] = await db.select().from(users).where(eq(users.id, p.carga.admin.conta.id));
    expect(admin!.role).toBe("admin");
    const [jog] = await db.select().from(users).where(eq(users.id, p.jogador.conta.id));
    expect(jog!.role).toBe("player");
  });

  it("15, 16: os 9 perfis de bot ligados e o estado grava o instante", async () => {
    const p = partidas[0]!;
    const ativos = await p.servidor.conexao.db.select({ profile: botsTabela.profile }).from(botsTabela).where(eq(botsTabela.active, true));
    expect(new Set(ativos.map((b) => b.profile)).size).toBe(9);
    const r = await p.servidor.conexao.db.execute<{ instante: Date }>(sql`select instante from public.partida_estado where id = 1`);
    expect(new Date(r.rows[0]!.instante).getTime()).toBe(p.carga.ipo.opensAt.getTime());
    expect(and).toBeDefined();
  });
});
