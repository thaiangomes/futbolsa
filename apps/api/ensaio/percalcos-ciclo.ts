import { and, asc, eq } from "drizzle-orm";
import { bots as botsTabela, clubs, matches, users, wallets } from "../src/infra/db/schema/index.js";
import type { ContextoEnsaio } from "./ensaio.js";
import type { Parada } from "./condutor.js";
import { Jogador } from "./jogadores.js";
import type { RegistroDePercalco } from "./percalcos.js";

/**
 * Percalços do ciclo e do dinheiro (T11 e T12): jogo adiado e cancelado, placar à mão, correção depois do pagamento com
 * estorno, exclusão de conta pelo jogador e pelo admin, entrada no meio, bots desligados e ligados depois do IPO e a chave dos bots
 * nos rankings. Cada um registra `ensaio <especificação> <n>` e confere o efeito; o verificador de invariantes confere o dinheiro
 * todo dia. Diferente de `percalcos.ts`, não para na primeira falha: junta tudo em `registros` e o teste olha no fim (uma
 * execução mostra todos os problemas).
 *
 * Datas: o ensaio curto vai até meados de abril de 2025 (Brasileirão, rodadas 1 e 2).
 */

const em = (iso: string) => new Date(iso).getTime();
const RAZAO = "ensaio: percalço marcado";

export function criarPercalcosDoCiclo(ctx: () => ContextoEnsaio) {
  const registros: RegistroDePercalco[] = [];
  const feitos = new Set<string>();
  const dados: Record<string, unknown> = {};

  const registrar = (percalco: string, criterio: string, quando: Date, ok: boolean, detalhe?: string) => {
    registros.push({ percalco, criterio, em: quando.toISOString(), ok, detalhe });
  };
  const admin = async (method: "POST" | "PATCH" | "DELETE" | "GET" | "PUT", url: string, payload?: object, extra: Record<string, string> = {}) => {
    const { servidor, carga } = ctx();
    const res = await servidor.app.inject({ method, url, payload, headers: { ...(await carga.admin.auth()), ...extra } });
    let corpo: any = null;
    try {
      corpo = res.json();
    } catch {
      corpo = res.body;
    }
    return { status: res.statusCode, corpo };
  };
  const uma = async (nome: string, quando: boolean, agir: () => Promise<void>) => {
    if (!quando || feitos.has(nome)) return;
    feitos.add(nome);
    try {
      await agir();
    } catch (erro) {
      registrar(nome, "(erro)", ctx().servidor.clock.now(), false, (erro as Error).message);
    }
  };
  const jogoDa = async (competicao: string, rodada: number, indice = 0) => {
    const { servidor } = ctx();
    const linhas = await servidor.conexao.db
      .select()
      .from(matches)
      .where(and(eq(matches.competition, competicao), eq(matches.round, rodada)))
      .orderBy(asc(matches.kickoff), asc(matches.id));
    return linhas[indice]!;
  };
  const usuario = async (apelido: string) => (await ctx().servidor.conexao.db.select({ id: users.id, status: users.status }).from(users).where(eq(users.nickname, apelido)))[0];

  async function antes(p: Parada): Promise<void> {
    const { servidor, carga, jogadores } = ctx();
    const t = p.em.getTime();

    // Admin 7 a 10, Dividendos 5: um jogo da rodada 2 é adiado e outro cancelado pela fonte; a importação do dia seguinte traz
    await uma("jogo adiado e cancelado pela fonte", t >= em("2025-04-01T12:00:00Z"), async () => {
      const adiado = await jogoDa("brasileirao-a", 2, 0);
      const cancelado = await jogoDa("brasileirao-a", 2, 1);
      dados.adiado = adiado.id;
      dados.cancelado = cancelado.id;
      servidor.fonte.substituir(p.em, { matchId: adiado.sourceId!, kickoff: "2025-04-23T21:00:00-03:00" });
      servidor.fonte.substituir(p.em, { matchId: cancelado.sourceId!, status: "cancelled" });
    });
    await uma("confere adiado e cancelado", t >= em("2025-04-03T12:00:00Z") && feitos.has("jogo adiado e cancelado pela fonte"), async () => {
      const [adiado] = await servidor.conexao.db.select().from(matches).where(eq(matches.id, dados.adiado as number));
      const [cancelado] = await servidor.conexao.db.select().from(matches).where(eq(matches.id, dados.cancelado as number));
      registrar("jogo adiado vira a nova data", "Admin 7", p.em, adiado!.kickoff.getTime() === em("2025-04-24T00:00:00Z"), `kickoff ${adiado!.kickoff.toISOString()} status ${adiado!.status}`);
      registrar("jogo cancelado pela fonte", "Admin 10", p.em, cancelado!.status === "cancelled", `status ${cancelado!.status}`);
    });

    // Admin 6: o admin preenche o placar de um jogo da rodada 2; a importação seguinte traz outro e vale o do admin
    await uma("placar à mão", t >= em("2025-04-03T18:00:00Z"), async () => {
      const jogo = await jogoDa("brasileirao-a", 2, 2);
      dados.placarMao = jogo.id;
      const r = await admin("PATCH", `/admin/matches/${jogo.id}`, { status: "finished", homeGoals: 7, awayGoals: 0, finishedAt: "2025-04-03T15:00:00.000Z", reason: RAZAO });
      registrar("placar preenchido à mão", "Admin 6", p.em, r.status < 300, `${r.status} ${JSON.stringify(r.corpo).slice(0, 160)}`);
    });
    await uma("confere placar à mão", t >= em("2025-04-12T12:00:00Z") && feitos.has("placar à mão"), async () => {
      const [jogo] = await servidor.conexao.db.select().from(matches).where(eq(matches.id, dados.placarMao as number));
      registrar("a importação não desfaz o placar do admin", "Admin 6", p.em, jogo!.homeGoals === 7 && jogo!.manualOverride === true, `${jogo!.homeGoals}x${jogo!.awayGoals} manual=${jogo!.manualOverride}`);
    });

    // Admin 11 a 16, Livro 17, Carteira 17: um placar de rodada já paga é corrigido; a prévia mostra o estorno e o admin aplica
    await uma("correção depois do pagamento", t >= em("2025-04-06T12:00:00Z"), async () => {
      const jogo = await jogoDa("brasileirao-a", 1, 0);
      const r = await admin("PATCH", `/admin/matches/${jogo.id}`, (jogo.homeGoals ?? 0) > (jogo.awayGoals ?? 0) ? { homeGoals: 0, awayGoals: 4, reason: RAZAO } : { homeGoals: 4, awayGoals: 0, reason: RAZAO });
      registrar("placar de rodada paga corrigido", "Admin 11", p.em, r.status < 300, `${r.status} ${JSON.stringify(r.corpo).slice(0, 160)}`);
      const previa = await admin("GET", "/admin/payouts/corrections");
      const mudou = (previa.corpo?.changes?.length ?? 0) > 0;
      registrar("a prévia da correção mostra o que muda", "Admin 12", p.em, previa.status === 200 && mudou, `${previa.status} mudanças ${previa.corpo?.changes?.length}`);
      if (mudou) {
        const aplicada = await admin("POST", "/admin/payouts/corrections", { planCode: previa.corpo.planCode, reason: RAZAO });
        registrar("correção aplicada com estorno e complemento", "Admin 13", p.em, aplicada.status === 200, `${aplicada.status} ${JSON.stringify(aplicada.corpo).slice(0, 160)}`);
      }
    });

    // Conta 22 e 23: um jogador exclui a própria conta e o admin exclui outro
    await uma("exclusão pelo jogador e pelo admin", t >= em("2025-04-07T12:00:00Z"), async () => {
      const proprio = jogadores.lista.find((j) => j.apelido === "jogador_3")!;
      const r1 = await proprio.http("DELETE", "/me", { confirmNickname: proprio.apelido });
      registrar("o jogador exclui a própria conta", "Conta 22", p.em, r1.status === 202, `${r1.status} ${JSON.stringify(r1.corpo).slice(0, 120)}`);
      const alvo = await usuario("jogador_4");
      const r2 = await admin("DELETE", `/admin/players/${alvo!.id}`, { confirmNickname: "jogador_4", reason: RAZAO });
      registrar("o admin exclui um jogador", "Conta 23", p.em, r2.status === 202, `${r2.status} ${JSON.stringify(r2.corpo).slice(0, 120)}`);
      // quem foi excluído sai da lista de jogadores que agem
      for (const apelido of ["jogador_3", "jogador_4"]) {
        const i = jogadores.lista.findIndex((j) => j.apelido === apelido);
        if (i >= 0) jogadores.lista.splice(i, 1);
      }
    });

    // Entrada 1 a 16: duas pessoas entram no meio, uma pelo índice e outra só com caixa
    await uma("entrada no meio", t >= em("2025-04-02T12:00:00Z"), async () => {
      for (const [apelido, modo] of [["entrante_indice", "index"], ["entrante_caixa", "cash"]] as const) {
        const novo = new Jogador(apelido, servidor, jogadores.resumo);
        const convite = await admin("POST", "/admin/invites", { emails: [novo.email] });
        await novo.cadastrar();
        const r = await novo.http("POST", "/entry", { mode: modo });
        registrar(`entrada no meio (${modo})`, "Entrada 1", p.em, r.status < 300 && convite.status < 300, `${r.status} ${JSON.stringify(r.corpo).slice(0, 160)}`);
      }
    });

    // Admin 29 e 30: bots desligados (de 2 para 1 trader) e ligados depois do IPO; Admin 35: a chave dos bots nos rankings
    await uma("bots desligados e ligados", t >= em("2025-04-05T12:00:00Z"), async () => {
      const menos = await admin("PATCH", "/admin/bots", { counts: { trader: 1 }, reason: RAZAO });
      registrar("bots desligados (trader de 2 para 1)", "Admin 30", p.em, menos.status === 200 && (menos.corpo?.turnedOff?.length ?? 0) === 1, `${menos.status} ${JSON.stringify(menos.corpo).slice(0, 120)}`);
      const mais = await admin("PATCH", "/admin/bots", { counts: { momentum: 2 }, reason: RAZAO });
      registrar("bot ligado depois do IPO", "Admin 29", p.em, mais.status === 200 && (mais.corpo?.created?.length ?? 0) === 1, `${mais.status} ${JSON.stringify(mais.corpo).slice(0, 120)}`);
    });
    await uma("chave dos bots nos rankings", t >= em("2025-04-05T18:00:00Z"), async () => {
      const r = await admin("PATCH", `/admin/seasons/${carga.seasonId}`, { botsInRankings: true });
      registrar("chave dos bots nos rankings ligada", "Admin 35", p.em, r.status === 200, `${r.status} ${JSON.stringify(r.corpo).slice(0, 120)}`);
    });
    void clubs;
    void wallets;
    void botsTabela;
  }

  return { antes, registros };
}
