import { describe, expect, it } from "vitest";
import { buybackEvents } from "../src/engine/buyback.js";
import { reais } from "../src/engine/money.js";
import { diffEvents, settle, type PayoutChange } from "../src/engine/payoutDiff.js";
import type { PayoutEvent, PayoutEventKind } from "../src/engine/payoutEvents.js";

const at = (iso: string) => Date.parse(iso);

function ev(
  kind: PayoutEventKind,
  clubId: string,
  stage: string,
  perShare: number,
  closedAt = at("2027-06-06T20:00:00-03:00"),
  competition = "brasileirao-a",
): PayoutEvent {
  return { key: `${kind}|${competition}|${stage}|${clubId}`, kind, clubId, competition, stage, perShare, closedAt, reason: `${kind} ${stage}` };
}

const posicoes = (obj: Record<string, number>) => new Map(Object.entries(obj));
const porClube = (mapa: Record<string, Record<string, number>>) => (c: PayoutChange) =>
  posicoes(mapa[c.key] ?? mapa[c.clubId] ?? {});

describe("diffEvents: prévia da correção", () => {
  it("admin 12: CAM3 de 2 × 1 para 1 × 1 cai de R$ 0,30 para R$ 0,10 por ação", () => {
    const antes = [ev("points", "CAM3", "10", 30), ev("points", "BOT3", "10", 0)].filter((e) => e.perShare > 0);
    const depois = [ev("points", "CAM3", "10", 10), ev("points", "BOT3", "10", 10)];
    const mudancas = diffEvents(antes, depois);
    const cam = mudancas.find((m) => m.clubId === "CAM3")!;
    expect(cam).toMatchObject({ before: 30, after: 10, delta: -20 });
  });

  it("admin 13: BOT3 não tinha evento e passa a ter R$ 0,10 por ação (evento novo, antes zero)", () => {
    const mudancas = diffEvents([ev("points", "CAM3", "10", 30)], [ev("points", "CAM3", "10", 10), ev("points", "BOT3", "10", 10)]);
    expect(mudancas.find((m) => m.clubId === "BOT3")).toMatchObject({ before: 0, after: 10, delta: 10 });
  });

  it("evento que sumiu fica com depois zero", () => {
    const mudancas = diffEvents([ev("points", "CAM3", "10", 30)], []);
    expect(mudancas).toEqual([expect.objectContaining({ clubId: "CAM3", before: 30, after: 0, delta: -30 })]);
  });

  it("evento que não muda não aparece na diferença", () => {
    const iguais = [ev("points", "CAM3", "10", 30), ev("placement", "FLA3", "fim", 500)];
    expect(diffEvents(iguais, iguais)).toEqual([]);
  });

  it("mudança só do instante de fechamento aparece, com os dois instantes", () => {
    const antes = [ev("points", "CAM3", "10", 30, at("2027-06-06T20:00:00-03:00"))];
    const depois = [ev("points", "CAM3", "10", 30, at("2027-06-07T20:00:00-03:00"))];
    expect(diffEvents(antes, depois)).toEqual([
      expect.objectContaining({ delta: 0, closedAtBefore: at("2027-06-06T20:00:00-03:00"), closedAtAfter: at("2027-06-07T20:00:00-03:00") }),
    ]);
  });

  it("recusa chaves repetidas na mesma versão", () => {
    expect(() => diffEvents([ev("points", "CAM3", "10", 30), ev("points", "CAM3", "10", 40)], [])).toThrow();
  });
});

describe("settle: estorno e complemento por carteira, pela posição no fechamento", () => {
  it("admin 12: Bruno, com 2.000 CAM3 e R$ 150,00 no fechamento, perde R$ 400,00 e fica com −R$ 250,00", () => {
    const mudancas = diffEvents([ev("points", "CAM3", "10", 30)], [ev("points", "CAM3", "10", 10)]);
    const ajustes = settle(mudancas, porClube({ CAM3: { bruno: 2_000 } }));
    expect(ajustes).toEqual([
      {
        walletId: "bruno",
        amount: reais(-400),
        items: [expect.objectContaining({ kind: "reversal", amount: reais(-400), clubId: "CAM3" })],
      },
    ]);
    expect(reais(150) + ajustes[0]!.amount).toBe(reais(-250));
  });

  it("admin 13: Carla, com 1.000 BOT3 no fechamento, recebe R$ 100,00 de complemento", () => {
    const mudancas = diffEvents([], [ev("points", "BOT3", "10", 10)]);
    const ajustes = settle(mudancas, porClube({ BOT3: { carla: 1_000 } }));
    expect(ajustes).toEqual([
      { walletId: "carla", amount: reais(100), items: [expect.objectContaining({ kind: "complement", amount: reais(100) })] },
    ]);
  });

  it("admin 17 e dividendos 25: título do VAS3 para o COR3, com a recompra dos dois recalculada (−R$ 12,00 e +R$ 12,00 por ação)", () => {
    const fechamento = at("2027-12-19T23:30:00-03:00");
    const listados = new Set(["VAS3", "COR3"]);
    const base = [ev("points", "VAS3", "1", reais(10)), ev("points", "COR3", "1", reais(5))];
    const tituloVAS = ev("cup_title", "VAS3", "final", reais(8), fechamento, "copa-do-brasil");
    const tituloCOR = ev("cup_title", "COR3", "final", reais(8), fechamento, "copa-do-brasil");

    const antes = [...base, tituloVAS];
    const depois = [...base, tituloCOR];
    const recompraAntes = buybackEvents(antes, listados, 15_000, fechamento);
    const recompraDepois = buybackEvents(depois, listados, 15_000, fechamento);

    const mudancas = diffEvents([...antes, ...recompraAntes], [...depois, ...recompraDepois]);
    const delta = (kind: string, clube: string) => mudancas.find((m) => m.kind === kind && m.clubId === clube)!.delta;
    expect(delta("cup_title", "VAS3")).toBe(reais(-8));
    expect(delta("cup_title", "COR3")).toBe(reais(8));
    expect(delta("buyback", "VAS3")).toBe(reais(-12));
    expect(delta("buyback", "COR3")).toBe(reais(12));

    // Quem tinha VAS3 devolve o título e a parte da recompra; quem tinha COR3 recebe, pela posição no fechamento.
    const ajustes = settle(
      mudancas,
      porClube({ "cup_title|copa-do-brasil|final|VAS3": { ana: 1_000 }, "buyback|temporada|fim|VAS3": { ana: 1_000 }, "cup_title|copa-do-brasil|final|COR3": { bia: 500 }, "buyback|temporada|fim|COR3": { bia: 500 } }),
    );
    expect(ajustes).toEqual([
      { walletId: "ana", amount: 1_000 * reais(-8) + 1_000 * reais(-12), items: expect.any(Array) },
      { walletId: "bia", amount: 500 * reais(8) + 500 * reais(12), items: expect.any(Array) },
    ]);
  });

  it("carteira com vários eventos soma, e cada estorno ou complemento é uma linha própria", () => {
    const mudancas = diffEvents(
      [ev("points", "CAM3", "10", 30), ev("points", "BOT3", "10", 30)],
      [ev("points", "CAM3", "10", 10), ev("points", "BOT3", "10", 50)],
    );
    const ajustes = settle(mudancas, porClube({ CAM3: { ana: 100 }, BOT3: { ana: 40 } }));
    expect(ajustes).toHaveLength(1);
    expect(ajustes[0]!.amount).toBe(100 * -20 + 40 * 20);
    expect(ajustes[0]!.items.map((i) => i.kind).sort()).toEqual(["complement", "reversal"]);
  });

  it("evento novo usa a foto do fechamento dele, entregue por quem chama", () => {
    const novo = ev("points", "BOT3", "10", 10, at("2027-06-06T20:00:00-03:00"));
    const mudancas = diffEvents([], [novo]);
    let recebido: PayoutChange | undefined;
    settle(mudancas, (c) => {
      recebido = c;
      return posicoes({ carla: 10 });
    });
    expect(recebido).toMatchObject({ closedAtAfter: novo.closedAt, before: 0 });
  });

  it("carteira sem ações na foto não entra, e mudança de instante sem mudança de valor não gera ajuste", () => {
    const mudancas = diffEvents([ev("points", "CAM3", "10", 30)], [ev("points", "CAM3", "10", 10)]);
    expect(settle(mudancas, () => posicoes({ ana: 0 }))).toEqual([]);
    const soInstante = diffEvents(
      [ev("points", "CAM3", "10", 30, 1_000)],
      [ev("points", "CAM3", "10", 30, 2_000)],
    );
    expect(settle(soInstante, () => posicoes({ ana: 100 }))).toEqual([]);
  });

  it("ordena as carteiras por id", () => {
    const mudancas = diffEvents([ev("points", "CAM3", "10", 30)], [ev("points", "CAM3", "10", 10)]);
    const ajustes = settle(mudancas, () => posicoes({ zeca: 1, ana: 1, mia: 1 }));
    expect(ajustes.map((a) => a.walletId)).toEqual(["ana", "mia", "zeca"]);
  });

  it("recusa quantidade de ações negativa ou não inteira na foto", () => {
    const mudancas = diffEvents([ev("points", "CAM3", "10", 30)], [ev("points", "CAM3", "10", 10)]);
    expect(() => settle(mudancas, () => posicoes({ ana: -1 }))).toThrow();
    expect(() => settle(mudancas, () => posicoes({ ana: 1.5 }))).toThrow();
  });

  it("regressão: quem recebeu o valor antigo e aplica a diferença fica com o que receberia pelo valor novo", () => {
    const antes = [ev("points", "CAM3", "10", 30), ev("placement", "CAM3", "fim", 500), ev("points", "BOT3", "10", 20)];
    const depois = [ev("points", "CAM3", "10", 10), ev("placement", "CAM3", "fim", 450), ev("points", "FLA3", "10", 30)];
    const fotos = { CAM3: { ana: 700, bia: 13 }, BOT3: { ana: 5 }, FLA3: { bia: 9, cai: 4 } };
    const mudancas = diffEvents(antes, depois);
    const ajustes = new Map(settle(mudancas, porClube(fotos)).map((a) => [a.walletId, a.amount]));

    const recebido = (eventos: PayoutEvent[], wallet: string) =>
      eventos.reduce((s, e) => s + e.perShare * ((fotos as Record<string, Record<string, number>>)[e.clubId]?.[wallet] ?? 0), 0);
    for (const wallet of ["ana", "bia", "cai"]) {
      expect(recebido(antes, wallet) + (ajustes.get(wallet) ?? 0)).toBe(recebido(depois, wallet));
    }
  });
});
