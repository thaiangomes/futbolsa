import { describe, expect, it } from "vitest";
import { ReplaySource } from "../../ensaio/replay-source.js";

describe("fonte de reprodução (P3)", () => {
  it("só revela o placar depois do fim previsto, no relógio simulado (Dividendos 6, 8)", async () => {
    let agora = new Date("2025-03-01T00:00:00Z");
    const fonte = new ReplaySource(() => agora);
    const antes = await fonte.fetchMatches("brasileirao-a", 2025);
    expect(antes).toHaveLength(380);
    expect(antes.every((m) => m.status === "scheduled" && m.homeGoals === null)).toBe(true);

    agora = new Date("2025-12-31T00:00:00Z");
    const depois = await fonte.fetchMatches("brasileirao-a", 2025);
    expect(depois.filter((m) => m.status === "finished")).toHaveLength(380);
    expect(depois.every((m) => m.homeGoals !== null)).toBe(true);
  });

  it("a classificação sai dos jogos revelados e respeita o intervalo de datas", async () => {
    let agora = new Date("2025-03-01T00:00:00Z");
    const fonte = new ReplaySource(() => agora);
    expect(await fonte.fetchStandings("brasileirao-a")).toEqual([]);
    agora = new Date("2025-12-31T00:00:00Z");
    const tabela = await fonte.fetchStandings("brasileirao-a");
    expect(tabela).toHaveLength(20);
    expect(tabela[0]!.position).toBe(1);
    const janela = await fonte.fetchMatches("brasileirao-a", 2025, { from: new Date("2025-04-01T00:00:00Z"), to: new Date("2025-04-07T00:00:00Z") });
    expect(janela.length).toBeGreaterThan(0);
    expect(janela.length).toBeLessThan(40);
  });

  it("o jogo cancelado do arquivo continua cancelado e as copas trazem a fase", async () => {
    const fonte = new ReplaySource(() => new Date("2025-12-31T00:00:00Z"));
    const lib = await fonte.fetchMatches("libertadores", 2025);
    expect(lib.filter((m) => m.status === "cancelled")).toHaveLength(1);
    expect(lib.every((m) => m.phase !== null)).toBe(true);
  });

  it("um percalço muda o placar só depois do instante marcado e a fonte pode falhar de propósito", async () => {
    let agora = new Date("2025-12-31T00:00:00Z");
    const fonte = new ReplaySource(() => agora);
    const jogo = (await fonte.fetchMatches("brasileirao-a", 2025))[0]!;
    fonte.substituir(new Date("2026-01-05T00:00:00Z"), { matchId: jogo.sourceId, placar: { homeGoals: 9, awayGoals: 9 } });
    expect((await fonte.fetchMatches("brasileirao-a", 2025))[0]!.homeGoals).toBe(jogo.homeGoals);
    agora = new Date("2026-01-06T00:00:00Z");
    expect((await fonte.fetchMatches("brasileirao-a", 2025))[0]!.homeGoals).toBe(9);
    fonte.failNext = 1;
    await expect(fonte.fetchMatches("brasileirao-a", 2025)).rejects.toThrow(/fora do ar/);
    await expect(fonte.fetchMatches("brasileirao-a", 2025)).resolves.toHaveLength(380);
  });
});
