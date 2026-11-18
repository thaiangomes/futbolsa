import { describe, expect, it, vi } from "vitest";
import { finishTime, type Match } from "@futbolsa/engine";
import { Condutor } from "../../ensaio/condutor.js";
import { ReplaySource } from "../../ensaio/replay-source.js";
import { paraMemoria, type Fotos } from "../../partida/dados.js";
import { MARGEM_DO_FECHAMENTO, PASSO_SALTO, PASSO_TEMPO_REAL, RelogioDaPartida, RelogioFlutuante } from "../../partida/relogio.js";

// F17, T6: o relógio da partida com as passadas de produção trocadas por passadas vazias (as passadas de verdade, com banco,
// estão em `partida.test.ts`). A grade de paradas, o limite, os saltos e o tempo real são os de verdade, com os dados reais de 2026.

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

interface Montagem {
  clock: RelogioFlutuante;
  fonte: ReplaySource;
  relogio: RelogioDaPartida;
  paradas: Array<{ em: number; motivo: string }>;
  /** Avança o relógio de verdade (o do computador do Thaian). */
  passarReal(ms: number): void;
  salvos: Date[];
  atualizacoes: { resposta: () => Promise<{ mudaram: string[]; limiteAntes: number | null; limiteDepois: number | null; fotos: Fotos }> };
  segurar: { portao: Promise<void> | null };
}

/** Uma passada vazia: o `app` do servidor de mentira devolve serviços que não fazem nada. */
function montar(inicio: string, o: { limite?: number; real?: number } = {}): Montagem {
  let real = o.real ?? 1_000_000;
  const clock = new RelogioFlutuante(new Date(inicio), () => real);
  const fonte = new ReplaySource(() => clock.now(), undefined, { ano: 2026 });
  if (o.limite !== undefined) {
    // os dados cortados no limite: só os jogos terminados até ali
    const dados = Object.fromEntries(
      (["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"] as const).map((c) => [c, fonte.matchesOf(c).filter((m) => m.status !== "finished" || finishTime(m) <= o.limite!)]),
    );
    fonte.trocarDados(dados);
  }
  const servico = new Proxy({}, { get: () => async () => undefined });
  const servidorDeMentira = { clock, fonte, conexao: {}, app: { get: () => servico } };
  const condutor = new Condutor(servidorDeMentira as never, { ipo: { opensAt: new Date("2026-01-14T12:00:00Z"), closesAt: new Date("2026-01-21T12:00:00Z"), tradingOpensAt: new Date("2026-01-22T13:00:00Z") }, year: 2026, seasonId: 1 } as never, { aprovar: false, chanceDeRepetir: 0 });
  const paradas: Montagem["paradas"] = [];
  const original = condutor.paradaEm.bind(condutor);
  const segurar: Montagem["segurar"] = { portao: null };
  condutor.paradaEm = async (em, motivo) => {
    if (segurar.portao) await segurar.portao;
    const p = await original(em, motivo);
    paradas.push({ em: p.em.getTime(), motivo });
    return p;
  };
  const salvos: Date[] = [];
  const atualizacoes: Montagem["atualizacoes"] = { resposta: async () => ({ mudaram: [], limiteAntes: null, limiteDepois: null, fotos: {} }) };
  const relogio = new RelogioDaPartida({ clock, condutor, fonte, salvar: async (d) => void salvos.push(d), atualizar: () => atualizacoes.resposta(), laco: false, agoraReal: () => real });
  return { clock, fonte, relogio, paradas, passarReal: (ms) => void (real += ms), salvos, atualizacoes, segurar };
}

const rodada = (fonte: ReplaySource, n: number): Match[] => fonte.matchesOf("brasileirao-a").filter((m) => m.round === n && !m.postponed);

describe("relógio da partida: saltos", () => {
  it("4: '1 dia' vai ao mesmo horário do dia seguinte, por todas as paradas do meio, em ordem e a no máximo 180 minutos", async () => {
    const m = montar("2026-04-04T12:00:00Z");
    const r = await m.relogio.pedir({ acao: "dia" });
    expect(r.estado.instante).toBe("2026-04-05T12:00:00.000Z");
    expect(r.avancou).toBe(true);
    const instantes = m.paradas.map((p) => p.em);
    expect(instantes).toEqual([...instantes].sort((a, b) => a - b));
    expect(new Set(instantes).size).toBe(instantes.length);
    let anterior = Date.parse("2026-04-04T12:00:00Z");
    for (const em of instantes) {
      expect(em - anterior).toBeLessThanOrEqual(PASSO_SALTO);
      anterior = em;
    }
    // a rodada do dia 4 de abril tem jogos às 16:00 (19:00 UTC): a parada de início de jogo está no meio
    expect(m.paradas.some((p) => p.motivo === "início de jogo")).toBe(true);
    expect(m.paradas.some((p) => p.motivo === "fim de jogo")).toBe(true);
    expect(instantes.at(-1)).toBe(Date.parse("2026-04-05T12:00:00Z"));
    expect(m.salvos.at(-1)?.toISOString()).toBe("2026-04-05T12:00:00.000Z");
  });

  it("5: 'até a próxima rodada' para quando termina o último jogo dela, com a parada (e o fechamento) nesse instante", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    const r = await m.relogio.pedir({ acao: "rodada" });
    // a próxima rodada: a menor cujo último jogo (fora os adiados) termina depois de agora
    const fim = (n: number) => Math.max(...rodada(m.fonte, n).map(finishTime));
    const esperada = [...new Set(m.fonte.matchesOf("brasileirao-a").map((x) => x.round!))].sort((a, b) => a - b).find((n) => fim(n) > Date.parse("2026-04-01T12:00:00Z"))!;
    expect(Date.parse(r.estado.instante)).toBe(fim(esperada) + MARGEM_DO_FECHAMENTO);
    expect(m.paradas.at(-1)!.em).toBe(fim(esperada) + MARGEM_DO_FECHAMENTO);
    expect(r.mensagem).toContain("até a próxima rodada");
  });

  it("18: a rodada com jogo remarcado para semanas depois não segura o salto: 'até a próxima rodada' para no fim dos jogos dentro da janela, e a tela diz o alvo", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    const agora = Date.parse("2026-04-01T12:00:00Z");
    const fim = (n: number) => Math.max(...rodada(m.fonte, n).map(finishTime));
    const n = [...new Set(m.fonte.matchesOf("brasileirao-a").map((x) => x.round!))].sort((a, b) => a - b).find((r) => fim(r) > agora)!;
    // o último jogo dessa rodada é remarcado para 60 dias depois (ainda agendado, sem o aviso de adiado)
    const ultimo = rodada(m.fonte, n).reduce((a, b) => (finishTime(a) >= finishTime(b) ? a : b));
    const remarcado: Match = { ...ultimo, kickoff: new Date(Date.parse(ultimo.kickoff) + 60 * DIA).toISOString(), finishedAt: undefined, status: "scheduled" };
    const dados = Object.fromEntries(
      (["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"] as const).map((c) => [c, m.fonte.matchesOf(c).map((x) => (x === ultimo ? remarcado : x))]),
    );
    m.fonte.trocarDados(dados);
    const outros = rodada(m.fonte, n).filter((x) => x !== remarcado && x.kickoff !== remarcado.kickoff);
    const esperado = Math.max(...outros.map(finishTime)) + MARGEM_DO_FECHAMENTO;
    const r = await m.relogio.pedir({ acao: "rodada" });
    expect(Date.parse(r.estado.instante)).toBe(esperado);
    expect(Date.parse(r.estado.instante)).toBeLessThan(Date.parse(remarcado.kickoff));
  });

  it("18: o alvo do salto aparece na tela enquanto ele corre, e 'pausar' interrompe o salto ao fim da parada atual", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    let soltar!: () => void;
    m.segurar.portao = new Promise<void>((ok) => (soltar = ok));
    const salto = m.relogio.pedir({ acao: "dia" });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(m.relogio.estado().ocupado).toBe("avançando até 02/04");
    const pausa = m.relogio.pedir({ acao: "pausar" }); // antes respondia "ocupado"
    m.segurar.portao = null;
    soltar();
    const [resposta] = await Promise.all([salto, pausa]);
    expect(resposta.mensagem).toContain("interrompido");
    const agora = m.clock.now().getTime();
    expect(agora).toBeGreaterThan(Date.parse("2026-04-01T12:00:00Z"));
    expect(agora).toBeLessThan(Date.parse("2026-04-02T12:00:00Z")); // parou no meio do dia
    expect(m.relogio.estado()).toMatchObject({ ocupado: null, modo: "pausado" });
    // e o relógio anda de novo depois
    expect((await m.relogio.pedir({ acao: "dia" })).avancou).toBe(true);
  });

  it("6: 'até X' para em X às 00:00 de Brasília; data no passado ou além do limite é recusada com a razão", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    await expect(m.relogio.pedir({ acao: "ate", data: "2026-03-30" })).rejects.toMatchObject({ code: "data_no_passado", status: 422 });
    await expect(m.relogio.pedir({ acao: "ate", data: "2026-04-01" })).rejects.toMatchObject({ code: "data_no_passado" });
    await expect(m.relogio.pedir({ acao: "ate", data: "amanhã" })).rejects.toMatchObject({ code: "data_invalida" });
    await expect(m.relogio.pedir({ acao: "ate", data: "2026-12-30" })).rejects.toMatchObject({ code: "alem_do_limite", status: 422 });
    expect(m.clock.now().toISOString()).toBe("2026-04-01T12:00:00.000Z"); // nada andou
    const r = await m.relogio.pedir({ acao: "ate", data: "2026-04-03" });
    expect(r.estado.instante).toBe("2026-04-03T03:00:00.000Z"); // 00:00 em Brasília
  });

  it("7: no limite o relógio não anda e diz 'aguardando resultados reais' com a data do último resultado", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    const limite = m.relogio.limiteMs()!;
    m.clock.set(new Date(limite));
    for (const acao of ["dia", "rodada"] as const) {
      const r = await m.relogio.pedir({ acao });
      expect(r.avancou).toBe(false);
      expect(r.mensagem).toMatch(/aguardando resultados reais \(último resultado em 2026-11-1\d\)/);
      expect(r.estado.aguardando).toBe(true);
    }
    expect(m.clock.now().getTime()).toBe(limite);
    expect(m.paradas).toHaveLength(0);
  });

  it("7, 20: um salto que passaria do limite para no limite", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    const limite = m.relogio.limiteMs()!;
    m.clock.set(new Date(limite - 2 * HORA));
    const r = await m.relogio.pedir({ acao: "dia" });
    expect(Date.parse(r.estado.instante)).toBe(limite);
    expect(r.estado.aguardando).toBe(true);
    expect(r.mensagem).toContain("aguardando resultados reais");
  });

  it("22: o relógio nunca anda para trás", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    m.clock.correr();
    m.passarReal(30 * MIN);
    m.clock.set(new Date("2026-04-01T12:10:00Z")); // um instante que já passou
    expect(m.clock.now().getTime()).toBe(Date.parse("2026-04-01T12:30:00Z"));
  });
});

describe("relógio da partida: atualizar", () => {
  it("8: sem jogos novos nada muda; com jogos novos o limite sobe; falha deixa tudo como estava", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    const antes = m.relogio.estado();
    // a hora da última baixa (item 23) muda a cada baixa que dá certo; o resto do estado não
    const semBaixa = (e: ReturnType<typeof m.relogio.estado>) => ({ ...e, baixadoEm: null, dadosFrescos: false });
    let r = await m.relogio.pedir({ acao: "atualizar" });
    expect(r.mensagem).toContain("nada de novo");
    expect(semBaixa(m.relogio.estado())).toEqual(semBaixa(antes));

    m.atualizacoes.resposta = async () => {
      throw new Error("a ESPN respondeu 503");
    };
    await expect(m.relogio.pedir({ acao: "atualizar" })).rejects.toMatchObject({ code: "atualizacao_falhou", status: 502 });
    expect(semBaixa(m.relogio.estado())).toEqual(semBaixa(antes));

    // a ESPN traz o último jogo da Copa do Brasil (a final, em 2026-12-06) já terminado
    const copa = m.fonte.matchesOf("copa-do-brasil").map((x) => (x.phase === "final" ? { ...x, status: "finished" as const, homeGoals: 1, awayGoals: 0 } : x));
    const fotos = { "copa-do-brasil": { matches: copa } } as unknown as Fotos;
    m.atualizacoes.resposta = async () => ({ mudaram: ["copa-do-brasil"], limiteAntes: m.fonte.limite(), limiteDepois: Date.parse("2026-12-06T17:00:00-03:00") + 2 * HORA, fotos: Object.fromEntries(["brasileirao-a", "brasileirao-b", "libertadores", "sul-americana"].map((c) => [c, { matches: m.fonte.matchesOf(c === "sul-americana" ? "sulamericana" : (c as "libertadores")) }])) as never as Fotos });
    // as outras competições vêm do que a fonte já tinha; só a copa mudou
    (fotos as Record<string, unknown>)["brasileirao-a"] = { matches: m.fonte.matchesOf("brasileirao-a") };
    const resposta = await m.atualizacoes.resposta();
    Object.assign(resposta.fotos, fotos);
    m.atualizacoes.resposta = async () => resposta;
    r = await m.relogio.pedir({ acao: "atualizar" });
    expect(r.mensagem).toContain("o limite subiu");
    expect(m.fonte.limite()).toBe(Date.parse("2026-12-06T17:00:00-03:00") + 2 * HORA);
    expect(paraMemoria(resposta.fotos)["copa-do-brasil"]!.some((x) => x.phase === "final" && x.status === "finished")).toBe(true);
    expect(r.estado.limite).toBe(new Date(Date.parse("2026-12-06T17:00:00-03:00") + 2 * HORA + MARGEM_DO_FECHAMENTO).toISOString());
  });
});

describe("relógio da partida: um pedido por vez", () => {
  it("10: dois saltos ao mesmo tempo — um anda, o outro é recusado com 'o relógio já está andando'", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    let soltar!: () => void;
    m.segurar.portao = new Promise<void>((ok) => (soltar = ok));
    const primeiro = m.relogio.pedir({ acao: "dia" });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(m.relogio.estado().ocupado).toBe("avançando até 02/04");
    await expect(m.relogio.pedir({ acao: "dia" })).rejects.toMatchObject({ code: "relogio_ocupado", status: 409, message: "o relógio já está andando" });
    await expect(m.relogio.pedir({ acao: "atualizar" })).rejects.toMatchObject({ code: "relogio_ocupado" });
    m.segurar.portao = null;
    soltar();
    await primeiro;
    expect(m.clock.now().toISOString()).toBe("2026-04-02T12:00:00.000Z");
    expect(m.relogio.estado().ocupado).toBeNull();
  });
});

describe("relógio da partida: tempo real", () => {
  it("19: 10 minutos de verdade são 10 minutos do jogo (±1), com as paradas de 5 em 5 minutos (item 23), e pausar para no instante", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    await m.relogio.pedir({ acao: "tempo-real" });
    expect(m.relogio.estado().modo).toBe("tempo-real");
    m.passarReal(4 * MIN);
    expect(Math.abs(m.clock.now().getTime() - Date.parse("2026-04-01T12:04:00Z"))).toBeLessThanOrEqual(MIN);
    await m.relogio.tique();
    // a primeira parada da grade de 5 minutos ainda não chegou: nenhuma parada, relógio andou
    expect(m.paradas).toHaveLength(0);
    m.passarReal(6 * MIN); // 10 minutos: as grades de :05 e :10 passaram
    await m.relogio.tique();
    expect(m.paradas.map((p) => p.em)).toEqual([Date.parse("2026-04-01T12:05:00Z"), Date.parse("2026-04-01T12:10:00Z")]);
    expect(m.paradas[0]!.motivo).toBe(`grade de ${PASSO_TEMPO_REAL / MIN} minutos`);
    expect(Math.abs(m.salvos.at(-1)!.getTime() - Date.parse("2026-04-01T12:10:00Z"))).toBeLessThanOrEqual(MIN); // grava o instante de agora
    expect(Math.abs(m.clock.now().getTime() - Date.parse("2026-04-01T12:10:00Z"))).toBeLessThanOrEqual(MIN);
    // pausar: o relógio para onde está
    const r = await m.relogio.pedir({ acao: "pausar" });
    const parado = Date.parse(r.estado.instante);
    m.passarReal(HORA);
    expect(m.clock.now().getTime()).toBe(parado);
    expect(r.estado.modo).toBe("pausado");
  });

  it("20: um salto em tempo real volta ao tempo real a partir do instante do salto", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    await m.relogio.pedir({ acao: "tempo-real" });
    m.passarReal(5 * MIN);
    const r = await m.relogio.pedir({ acao: "dia" });
    expect(r.estado.modo).toBe("tempo-real");
    expect(Date.parse(r.estado.instante)).toBe(Date.parse("2026-04-01T12:05:00Z") + DIA);
    expect(m.clock.andando).toBe(true);
    m.passarReal(MIN);
    expect(m.clock.now().getTime()).toBe(Date.parse("2026-04-01T12:05:00Z") + DIA + MIN);
  });

  it("20: o tempo real também para no limite, com 'aguardando resultados reais'", async () => {
    const m = montar("2026-04-01T12:00:00Z");
    const limite = m.relogio.limiteMs()!;
    m.clock.set(new Date(limite - 20 * MIN));
    await m.relogio.pedir({ acao: "tempo-real" });
    m.passarReal(HORA);
    await m.relogio.tique();
    const e = m.relogio.estado();
    expect(e.aguardando).toBe(true);
    expect(e.modo).toBe("pausado");
    expect(Date.parse(e.instante)).toBe(limite);
    expect(m.clock.andando).toBe(false);
    const r = await m.relogio.pedir({ acao: "tempo-real" });
    expect(r.mensagem).toContain("aguardando resultados reais");
  });
});

describe("fonte de reprodução de 2026", () => {
  it("9: um jogo por jogar continua agendado e sem placar depois do horário previsto", async () => {
    // a final da Sul-Americana de 2026 está por jogar na foto de 2026-11-15 (2026-11-21 19:30)
    let agora = new Date("2026-11-20T12:00:00Z");
    const fonte = new ReplaySource(() => agora, undefined, { ano: 2026 });
    const final = (await fonte.fetchMatches("sulamericana", 2026)).find((x) => x.phase === "final")!;
    expect(final.status).toBe("scheduled");
    agora = new Date("2026-12-31T12:00:00Z");
    const depois = (await fonte.fetchMatches("sulamericana", 2026)).find((x) => x.phase === "final")!;
    expect(depois).toMatchObject({ status: "scheduled", homeGoals: null, awayGoals: null, advancedName: null });
  });

  it("3, 22: o placar só aparece depois do fim previsto do jogo", async () => {
    const jogo = new ReplaySource(() => new Date(0), undefined, { ano: 2026 }).matchesOf("brasileirao-a").find((x) => x.status === "finished")!;
    let agora = new Date(Date.parse(jogo.kickoff) + 90 * MIN);
    const fonte = new ReplaySource(() => agora, undefined, { ano: 2026 });
    const vista = async () => (await fonte.fetchMatches("brasileirao-a", 2026)).find((x) => x.homeName && Math.abs(x.kickoff.getTime() - Date.parse(jogo.kickoff)) < 1 && x.sourceId === jogo.id)!;
    expect(await vista()).toMatchObject({ status: "scheduled", homeGoals: null });
    agora = new Date(finishTime(jogo));
    expect(await vista()).toMatchObject({ status: "finished", homeGoals: jogo.homeGoals });
  });

  it("limite: o fim do último jogo terminado dos dados; as fotos em memória trocam os arquivos", () => {
    const fonte = new ReplaySource(() => new Date(), undefined, { ano: 2026 });
    expect(new Date(fonte.limite()!).toISOString().slice(0, 10)).toBe("2026-11-15"); // 20:30 em Brasília + 2 h de jogo = 01:30 UTC do dia 15
    const so = new ReplaySource(() => new Date(), undefined, { ano: 2026, dados: { "brasileirao-a": [{ id: "x", competition: "brasileirao-a", round: 1, kickoff: "2026-02-01T16:00:00-03:00", home: "FLA3", away: "PAL3", homeGoals: 1, awayGoals: 0, status: "finished" }] } });
    expect(so.limite()).toBe(Date.parse("2026-02-01T18:00:00-03:00"));
    expect(new ReplaySource(() => new Date(), undefined, { ano: 2026, dados: {} }).limite()).toBeNull();
  });
});

// Item 23 das melhorias: jogar em tempo real durante os jogos. Dados baixados há pouco liberam o relógio até a hora real; no tempo
// real, perto dela, a partida baixa os dados sozinha a cada 5 minutos e o relógio acompanha a hora de verdade.
describe("relógio da partida: a hora real e a baixa automática (item 23)", () => {
  const T = (iso: string) => Date.parse(iso);
  const CORTE = T("2026-04-05T00:00:00Z"); // os dados terminam aqui: nenhum jogo terminado depois
  const REAL = T("2026-04-07T12:00:00Z"); // a hora de verdade: dois dias além do último jogo terminado

  it("23.1: sem dados frescos o relógio para no último jogo terminado; baixados há pouco, ele pode ir até a hora real (e não além)", async () => {
    const m = montar("2026-04-05T12:00:00Z", { limite: CORTE, real: REAL });
    // já está no limite dos jogos: sem baixar, "aguardando resultados reais"
    expect(m.relogio.estado()).toMatchObject({ aguardando: true, dadosFrescos: false, baixadoEm: null });
    expect((await m.relogio.pedir({ acao: "dia" })).avancou).toBe(false);

    await m.relogio.pedir({ acao: "atualizar" }); // a ESPN não trouxe nada de novo, mas os dados são de agora
    expect(m.relogio.estado()).toMatchObject({ aguardando: false, dadosFrescos: true, limite: new Date(REAL).toISOString() });
    const r = await m.relogio.pedir({ acao: "dia" });
    expect(r.avancou).toBe(true);
    expect(r.estado.instante).toBe("2026-04-06T12:00:00.000Z");
    // uma data depois da hora real continua recusada, com a razão
    await expect(m.relogio.pedir({ acao: "ate", data: "2026-04-09" })).rejects.toMatchObject({ code: "alem_do_limite" });
  });

  it("23.1: os dados deixam de ser frescos depois de 12 minutos sem baixar, e o limite volta a ser o do último jogo terminado", async () => {
    const m = montar("2026-04-05T12:00:00Z", { limite: CORTE, real: REAL });
    await m.relogio.pedir({ acao: "atualizar" });
    m.passarReal(11 * MIN);
    expect(m.relogio.estado().dadosFrescos).toBe(true);
    m.passarReal(2 * MIN);
    expect(m.relogio.estado()).toMatchObject({ dadosFrescos: false, aguardando: true });
  });

  it("23.2 e 23.3: no tempo real, perto da hora real, baixa os dados sozinha a cada 5 minutos, para a cada 5 minutos e não pausa no último jogo terminado", async () => {
    const m = montar("2026-04-07T12:00:00Z", { limite: CORTE, real: REAL });
    let baixas = 0;
    m.atualizacoes.resposta = async () => {
      baixas++;
      return { mudaram: [], limiteAntes: null, limiteDepois: null, fotos: {} };
    };
    await m.relogio.pedir({ acao: "atualizar" });
    expect(baixas).toBe(1);
    await m.relogio.pedir({ acao: "tempo-real" });
    expect(m.relogio.estado().modo).toBe("tempo-real");

    for (let i = 1; i <= 3; i++) {
      m.passarReal(5 * MIN);
      await m.relogio.tique();
      expect(baixas).toBe(1 + i); // uma baixa a cada 5 minutos
    }
    // o relógio acompanhou a hora real (3 × 5 minutos), com uma parada a cada 5 minutos, e segue em tempo real
    expect(m.clock.now().getTime()).toBe(REAL + 15 * MIN);
    expect(m.paradas.filter((p) => p.motivo.startsWith("grade")).map((p) => p.em - REAL)).toEqual([5 * MIN, 10 * MIN, 15 * MIN]);
    expect(m.relogio.estado()).toMatchObject({ modo: "tempo-real", aguardando: false, dadosFrescos: true });
  });

  it("23.2: sem tempo real, ou com o relógio longe da hora real, não baixa sozinha", async () => {
    const m = montar("2026-04-05T12:00:00Z", { limite: CORTE, real: REAL });
    let baixas = 0;
    m.atualizacoes.resposta = async () => {
      baixas++;
      return { mudaram: [], limiteAntes: null, limiteDepois: null, fotos: {} };
    };
    await m.relogio.pedir({ acao: "atualizar" });
    await m.relogio.pedir({ acao: "tempo-real" }); // dois dias atrás da hora real: reproduz o passado em tempo real
    m.passarReal(10 * MIN);
    await m.relogio.tique();
    expect(baixas).toBe(1); // só a manual
  });

  it("23.2: se a baixa automática falha, os dados deixam de ser frescos e o tempo real pausa em \"aguardando resultados reais\"", async () => {
    const m = montar("2026-04-07T12:00:00Z", { limite: CORTE, real: REAL });
    await m.relogio.pedir({ acao: "atualizar" });
    await m.relogio.pedir({ acao: "tempo-real" });
    m.atualizacoes.resposta = async () => {
      throw new Error("a ESPN caiu");
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.passarReal(13 * MIN); // passou do frescor dos dados e nenhuma baixa deu certo
    await m.relogio.tique();
    log.mockRestore();
    expect(m.relogio.estado()).toMatchObject({ modo: "pausado", aguardando: true, dadosFrescos: false });
  });

  it("23.1: 'agora' baixa os dados, salta até a hora real e liga o tempo real", async () => {
    const m = montar("2026-04-06T12:00:00Z", { limite: CORTE, real: REAL });
    const r = await m.relogio.pedir({ acao: "agora" });
    expect(r.avancou).toBe(true);
    expect(r.estado).toMatchObject({ instante: new Date(REAL).toISOString(), modo: "tempo-real", dadosFrescos: true, aguardando: false });
    expect(r.mensagem).toContain("tempo real");
    // com o relógio já na hora real, só liga o tempo real
    const p = montar("2026-04-07T12:00:00Z", { limite: CORTE, real: REAL });
    const r2 = await p.relogio.pedir({ acao: "agora" });
    expect(r2.estado).toMatchObject({ instante: new Date(REAL).toISOString(), modo: "tempo-real" });
  });
});
