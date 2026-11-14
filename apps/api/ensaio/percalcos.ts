import { eq } from "drizzle-orm";
import { clubs, seasonClubs, users } from "../src/infra/db/schema/index.js";
import type { ContextoEnsaio } from "./ensaio.js";
import { DIA, HORA, type Parada } from "./condutor.js";

/**
 * Percalços do ensaio (T11 e T12, parte já automatizada): em paradas marcadas o ensaio provoca os casos difíceis das
 * especificações e confere o efeito logo depois. O verificador de invariantes roda todo dia como sempre, então um percalço que
 * quebre dinheiro, ações ou reservas derruba o ensaio no dia seguinte.
 *
 * Feitos: a API cai e sobe no meio do IPO e na parada do fim do mês (Livro 25; IPO 27; Rankings 11), suspensão de um clube e do
 * mercado (Admin 23, 24; Livro 32), bloqueio e desbloqueio de um jogador (Admin 25, 26) e ajuste de caixa pelo admin (Admin 27).
 * Pendentes: jogo adiado e cancelado, correção de placar depois do pagamento com estorno, exclusão de conta, entrada no meio,
 * encerramento (T11 e T12 do plano).
 */

export interface RegistroDePercalco {
  percalco: string;
  criterio: string;
  em: string;
  ok: boolean;
  detalhe?: string;
}

export function criarPercalcos(ctx: () => ContextoEnsaio) {
  const registros: RegistroDePercalco[] = [];
  const feitos = new Set<string>();
  const registrar = (percalco: string, criterio: string, em: Date, ok: boolean, detalhe?: string) => {
    registros.push({ percalco, criterio, em: em.toISOString(), ok, detalhe });
    if (!ok) throw new Error(`percalço "${percalco}" (${criterio}) falhou: ${detalhe}`);
  };
  const admin = async (method: "POST" | "DELETE", url: string, payload?: object, extra: Record<string, string> = {}) => {
    const { servidor, carga } = ctx();
    const res = await servidor.app.inject({ method, url, payload, headers: { ...(await carga.admin.auth()), ...extra } });
    return { status: res.statusCode, corpo: res.body };
  };
  const uma = (nome: string, quando: boolean, agir: () => Promise<void>) => {
    if (!quando || feitos.has(nome)) return Promise.resolve();
    feitos.add(nome);
    return agir();
  };

  async function antes(p: Parada): Promise<void> {
    const { servidor, carga, jogadores } = ctx();
    const t = p.em.getTime();
    const abertura = carga.ipo.tradingOpensAt.getTime();

    // a API cai e volta com o IPO aberto
    await uma("queda no IPO", t >= carga.ipo.opensAt.getTime() + 20 * HORA && t < carga.ipo.closesAt.getTime(), async () => {
      await servidor.derrubar();
      await servidor.subir();
      const ok = (await fetch(`${servidor.url}/health`)).status === 200;
      registrar("API cai e volta no meio do IPO", "IPO 27", p.em, ok, ok ? undefined : "health fora do ar");
      if (jogadores.observador) await jogadores.observador.conectarWs(carga.tickers);
    });

    // suspensão de um clube por um dia
    await uma("suspende clube", t >= abertura + DIA, async () => {
      const r = await admin("POST", "/admin/suspensions", { ticker: "FLA3", reason: "ensaio: suspensão marcada" });
      const [linha] = await servidor.conexao.db
        .select({ motivo: seasonClubs.suspendedReason })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(clubs.ticker, "FLA3"));
      registrar("suspensão de um clube", "Admin 23", p.em, r.status < 300 && !!linha?.motivo, `${r.status} ${r.corpo.slice(0, 120)}`);
    });
    await uma("retoma clube", t >= abertura + 2 * DIA, async () => {
      const r = await admin("DELETE", "/admin/suspensions/FLA3");
      const [linha] = await servidor.conexao.db
        .select({ motivo: seasonClubs.suspendedReason })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(clubs.ticker, "FLA3"));
      registrar("retomada do clube", "Livro 32", p.em, r.status < 300 && !linha?.motivo, `${r.status}`);
    });

    // suspensão do mercado inteiro por uma parada
    await uma("suspende mercado", t >= abertura + 3 * DIA, async () => {
      const r = await admin("POST", "/admin/suspensions", { reason: "ensaio: mercado suspenso" });
      registrar("suspensão do mercado", "Admin 24", p.em, r.status < 300, `${r.status} ${r.corpo.slice(0, 120)}`);
    });
    await uma("retoma mercado", t >= abertura + 3 * DIA + 6 * HORA, async () => {
      const r = await admin("DELETE", "/admin/suspensions");
      registrar("retomada do mercado", "Admin 24", p.em, r.status < 300, `${r.status}`);
    });

    // bloqueio, ajuste e desbloqueio de um jogador
    const alvo = async () => (await servidor.conexao.db.select({ id: users.id, status: users.status }).from(users).where(eq(users.nickname, "jogador_2")))[0];
    await uma("bloqueia jogador", t >= abertura + 4 * DIA, async () => {
      const u = await alvo();
      const r = await admin("POST", `/admin/players/${u!.id}/block`, { reason: "ensaio: bloqueio marcado" });
      const depois = await alvo();
      registrar("bloqueio de um jogador", "Admin 25", p.em, r.status < 300 && depois?.status === "blocked", `${r.status} ${r.corpo.slice(0, 120)}`);
    });
    await uma("ajusta caixa", t >= abertura + 4 * DIA + 6 * HORA, async () => {
      const u = await alvo();
      const r = await admin("POST", `/admin/players/${u!.id}/adjust`, { asset: "cash", delta: 5_000, reason: "ensaio: ajuste de caixa" }, { "idempotency-key": "ensaio-ajuste-1" });
      registrar("ajuste de caixa pelo admin", "Admin 27", p.em, r.status < 300, `${r.status} ${r.corpo.slice(0, 120)}`);
    });
    await uma("desbloqueia jogador", t >= abertura + 5 * DIA, async () => {
      const u = await alvo();
      const r = await admin("POST", `/admin/players/${u!.id}/unblock`, { reason: "ensaio: desbloqueio marcado" });
      const depois = await alvo();
      registrar("desbloqueio de um jogador", "Admin 26", p.em, r.status < 300 && depois?.status === "active", `${r.status} ${r.corpo.slice(0, 120)}`);
    });
  }

  return { antes, registros };
}
