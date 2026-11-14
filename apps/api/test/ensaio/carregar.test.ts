import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipoDates } from "@futbolsa/engine";
import { criarServidorEnsaio, type ServidorEnsaio } from "../../ensaio/servidor.js";
import { carregarTemporada2025, type Carregado } from "../../ensaio/carregar.js";
import { matches, seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import { IpoJob } from "../../src/modules/ipo/index.js";
import { ImportRunner } from "../../src/modules/admin/results/import-runner.js";
import { createTestDatabase, type TestDatabase } from "../support/db.js";

describe("carregador da temporada de 2025 (T3)", () => {
  let banco: TestDatabase;
  let servidor: ServidorEnsaio;
  let carga: Carregado;

  beforeAll(async () => {
    banco = await createTestDatabase(10);
    servidor = await criarServidorEnsaio({ databaseUrl: banco.url, inicio: new Date("2025-03-01T12:00:00Z"), poolSize: 10 });
    carga = await carregarTemporada2025(servidor, { offerSize: 3000 });
  });
  afterAll(async () => {
    await servidor.fechar();
    await banco.close();
  });

  it("ipo 1: deixa a temporada de 2025 em preparação com os 20 clubes, a oferta e o primeiro jogo", async () => {
    const [temporada] = await servidor.conexao.db.select().from(seasons).where(eq(seasons.id, carga.seasonId));
    expect(temporada!.year).toBe(2025);
    expect(temporada!.status).toBe("preparing");
    expect(temporada!.offerSize).toBe(3000);
    expect(temporada!.firstKickoff!.toISOString()).toBe(carga.firstKickoff.toISOString());
    expect(await servidor.conexao.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, carga.seasonId))).toHaveLength(20);
    const datas = ipoDates(carga.firstKickoff.getTime());
    expect(carga.ipo.opensAt.getTime()).toBe(datas.opensAt);
  });

  it("ipo 2: a primeira importação traz os jogos sem placar e a abertura do IPO acontece no horário", async () => {
    servidor.clock.set(new Date(carga.ipo.opensAt.getTime() + 60_000));
    const relatorios = await servidor.app.get(ImportRunner).runCalendarIfStale();
    expect(relatorios.length).toBeGreaterThan(0);
    expect(relatorios.every((r) => r.error === null)).toBe(true);
    const jogos = await servidor.conexao.db.select().from(matches);
    expect(jogos.filter((j) => j.competition === "brasileirao-a")).toHaveLength(380);
    // as copas já tinham jogos antes do IPO; o Brasileirão ainda não começou
    expect(jogos.filter((j) => j.competition === "brasileirao-a").every((j) => j.homeGoals === null)).toBe(true);
    const passada = await servidor.app.get(IpoJob).runOnce();
    expect(passada).toMatchObject({ opening: { status: "opened" } });
    const [temporada] = await servidor.conexao.db.select().from(seasons).where(eq(seasons.id, carga.seasonId));
    expect(temporada!.status).toBe("ipo_open");
  });
});
