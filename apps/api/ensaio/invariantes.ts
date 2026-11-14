import { sql } from "drizzle-orm";
import { ENTRY_TOTAL, monthKey } from "@futbolsa/engine";
import { type Database, type DrizzleTx, Tx, withTransaction } from "../src/infra/db/index.js";
import { EquityAt } from "../src/modules/portfolio/valuation/equity-at.js";
import { closeAtOfMonth } from "../src/modules/rankings/base.js";
import { equityAtWallets } from "../src/modules/rankings/equity-at.js";
import {
  assertCandlesMatchTrades,
  assertLedgerConsistent,
  assertOpenOrdersCounter,
  assertReservesMatchOrders,
  assertSharesConserved,
} from "../test/support/invariants.js";
import { descreverAchado, procurarRelogioReal } from "./detector-relogio.js";
import type { ServidorEnsaio } from "./servidor.js";

/**
 * Verificador de invariantes do ensaio (T8 do Plano do ensaio): o oráculo do dinheiro e das ações. Roda depois de cada dia
 * simulado (gancho `depois` do condutor, na primeira parada de cada dia e nas paradas das 23h59 do fim do mês) e no fim. Tudo
 * **sem tolerância**: um centavo ou uma ação de diferença é violação.
 *
 * Só lê: com o servidor ou o banco, as leituras correm numa transação `read only` e `repeatable read` (uma foto só, e o
 * Postgres recusa qualquer escrita). Com uma transação já aberta (os testes que estragam dados de propósito), lê nela.
 *
 * Junta as violações do dia e falha uma vez, com a lista (`ViolacoesDeInvariantes`).
 */

/** O que o verificador guarda entre um dia e outro. */
export interface EstadoVerificador {
  /** Patrimônio de cada carteira (jogadores e bots) lido do **estado** na parada das 23h59 do fim de cada mês, em centavos. */
  patrimonioFimDoMes: Map<string, Map<number, number>>;
  /** Quantas vezes o verificador rodou. */
  dias: number;
  /** O dinheiro do último dia verificado: o caixa somado e o que a abertura mais os lançamentos do jogo explicam. */
  ultimo?: { em: Date; caixaTotal: number; explicado: number };
}

export function novoEstadoVerificador(): EstadoVerificador {
  return { patrimonioFimDoMes: new Map(), dias: 0 };
}

export interface OpcoesVerificador {
  /** Roda também o detector de relógio real (padrão: sim), com o relógio simulado da parada. */
  relogio?: boolean;
  /** O instante de verdade para o detector (padrão `Date.now()`). */
  agoraReal?: Date;
}

export interface RelatorioDia {
  em: Date;
  /** Quantas invariantes foram conferidas. */
  conferidas: number;
  caixaTotal: number;
  /** O mês cujo patrimônio foi lido nesta parada (só na parada das 23h59 do último dia). */
  fimDoMes: string | null;
}

export class ViolacoesDeInvariantes extends Error {
  constructor(
    readonly em: Date,
    readonly violacoes: string[],
  ) {
    super(`invariantes violadas em ${em.toISOString()} (${violacoes.length}):\n${violacoes.map((v) => `- ${v}`).join("\n")}`);
    this.name = "ViolacoesDeInvariantes";
  }
}

/** Onde o verificador lê: o servidor do ensaio, o banco ou uma transação já aberta. */
export type AlvoVerificador = Pick<ServidorEnsaio, "conexao"> | Database | DrizzleTx;

type Leitor = DrizzleTx | Database;

function ehTransacao(alvo: AlvoVerificador): alvo is DrizzleTx {
  return typeof (alvo as { rollback?: unknown }).rollback === "function";
}

/** Roda `fn` numa leitura só: na transação dada, ou numa nova `read only` e `repeatable read`. */
async function lendo<T>(alvo: AlvoVerificador, fn: (db: Leitor, tx: Tx) => Promise<T>): Promise<T> {
  if (ehTransacao(alvo)) return fn(alvo, new Tx(alvo));
  const db = "conexao" in alvo ? alvo.conexao.db : alvo;
  return withTransaction(db, (tx) => fn(tx.db, tx), { readOnly: true, isolationLevel: "repeatable read" });
}

const reais = (centavos: number) => `R$ ${(centavos / 100).toFixed(2)}`;

async function linhas(db: Leitor, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  return (await db.execute(query)).rows as Record<string, unknown>[];
}

/** Junta as falhas de cada invariante com o nome dela (e o critério da especificação que ela prova). */
class Coletor {
  readonly violacoes: string[] = [];
  conferidas = 0;

  async checar(nome: string, fn: () => Promise<void | string[]>): Promise<void> {
    this.conferidas++;
    try {
      const achadas = await fn();
      if (achadas && achadas.length > 0) this.violacoes.push(`${nome}: ${achadas.slice(0, 20).join("; ")}${achadas.length > 20 ? ` (e mais ${achadas.length - 20})` : ""}`);
    } catch (error) {
      this.violacoes.push(`${nome}: ${(error as Error).message.replace(/\n/g, " | ")}`);
    }
  }
}

/** Os tipos de linha do extrato que trazem dinheiro de fora ou o levam para fora (os "lançamentos do jogo"). */
const PAGAMENTOS = ["dividend", "complement", "reversal", "buyback"] as const;

// ---------------------------------------------------------------------------------------------------------------------
// (b) dinheiro total

/**
 * O dinheiro só entra e sai por lançamentos do jogo: os R$ 100.000,00 de abertura (`initial`), os pagamentos (dividendo,
 * complemento, estorno e recompra, conferidos contra `payout_credits`), o ajuste do admin, a emissão da entrada no meio
 * (`index_entry`, o caixa vira ações novas), o encerramento e a exclusão de conta. Todo o resto é transferência entre carteiras
 * (negócio, liquidação do IPO, anulação) e soma zero. Devolve o caixa somado e o explicado.
 */
async function conferirDinheiro(db: Leitor, seasonId: number, c: Coletor): Promise<{ caixaTotal: number; explicado: number }> {
  let caixaTotal = 0;
  let explicado = 0;
  await c.checar("dinheiro total constante (fora os lançamentos do jogo)", async () => {
    const [r] = await linhas(
      db,
      sql`select
            (select coalesce(sum(w.cash), 0) from futbolsa.wallets w where w.season_id = ${seasonId})::bigint as caixa,
            (select coalesce(sum(e.cash_delta), 0) from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
              where w.season_id = ${seasonId} and e.kind in ('initial', 'adjustment', 'index_entry', 'season_close', 'account_deleted'))::bigint as abertura_e_admin,
            (select coalesce(sum(pc.amount), 0) from futbolsa.payout_credits pc join futbolsa.payout_events pe on pe.id = pc.event_id
              where pe.season_id = ${seasonId})::bigint as pagamentos`,
    );
    caixaTotal = Number(r!.caixa);
    explicado = Number(r!.abertura_e_admin) + Number(r!.pagamentos);
    if (caixaTotal !== explicado) {
      return [
        `o caixa somado de todas as carteiras (jogadores, bots e tesouraria) é ${reais(caixaTotal)}, mas a abertura, os pagamentos e os ajustes explicam ${reais(explicado)} (diferença de ${caixaTotal - explicado} centavos)`,
      ];
    }
  });
  await c.checar("negócio transfere dinheiro e ações sem criar nem sumir", async () => {
    const r = await linhas(
      db,
      sql`select t.id, t.price, t.quantity, count(e.id)::int as linhas,
            coalesce(sum(e.cash_delta), 0)::bigint as caixa, coalesce(sum(e.shares_delta), 0)::bigint as acoes,
            coalesce(sum(e.cash_delta) filter (where e.shares_delta < 0), 0)::bigint as vendedor_recebeu
          from futbolsa.trades t
          left join futbolsa.wallet_entries e on e.kind = 'trade' and e.ref_type = 'trade' and e.ref_id = t.id::text
          where t.season_id = ${seasonId}
          group by t.id
          having count(e.id) <> 2 or coalesce(sum(e.cash_delta), 0) <> 0 or coalesce(sum(e.shares_delta), 0) <> 0
            or coalesce(sum(e.cash_delta) filter (where e.shares_delta < 0), 0) <> t.price * t.quantity`,
    );
    const orfas = await linhas(
      db,
      sql`select e.id, e.wallet_id, e.ref_id from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
          where w.season_id = ${seasonId} and e.kind = 'trade'
            and not exists (select 1 from futbolsa.trades t where t.season_id = ${seasonId} and e.ref_type = 'trade' and t.id::text = e.ref_id)`,
    );
    return [
      ...r.map((x) => `negócio ${x.id} (${x.quantity} × ${reais(Number(x.price))}): ${x.linhas} linhas no extrato, caixa somado ${x.caixa}, ações somadas ${x.acoes}, vendedor recebeu ${x.vendedor_recebeu}`),
      ...orfas.map((x) => `linha ${x.id} da carteira ${x.wallet_id} é de negócio que não existe (${x.ref_id})`),
    ];
  });
  await c.checar("liquidação do IPO só transfere dinheiro para a tesouraria", async () => {
    const r = await linhas(
      db,
      sql`select c.ticker, sum(e.cash_delta)::bigint as caixa
          from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id join futbolsa.clubs c on c.id = e.club_id
          where w.season_id = ${seasonId} and e.kind = 'ipo_settle'
          group by c.ticker having sum(e.cash_delta) <> 0`,
    );
    return r.map((x) => `clube ${x.ticker}: as linhas ipo_settle somam ${x.caixa} centavos (deviam somar zero)`);
  });
  await c.checar("reservas não mexem no caixa", async () => {
    const r = await linhas(
      db,
      sql`select e.id, e.wallet_id, e.kind, e.cash_delta from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
          where w.season_id = ${seasonId} and e.kind in ('ipo_reserve', 'order_reserve', 'order_release') and e.cash_delta <> 0`,
    );
    return r.map((x) => `linha ${x.id} (${x.kind}) da carteira ${x.wallet_id} mexe ${x.cash_delta} centavos no caixa`);
  });
  await c.checar("anulação de negócio soma zero", async () => {
    const r = await linhas(
      db,
      sql`select e.ref_id, sum(e.cash_delta)::bigint as caixa, sum(e.shares_delta)::bigint as acoes
          from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
          where w.season_id = ${seasonId} and e.kind = 'trade_annulled'
          group by e.ref_id having sum(e.cash_delta) <> 0 or sum(e.shares_delta) <> 0`,
    );
    return r.map((x) => `anulação do negócio ${x.ref_id}: caixa somado ${x.caixa}, ações somadas ${x.acoes}`);
  });
  await c.checar("pagamento no caixa igual ao crédito registrado", async () => {
    const semCredito = await linhas(
      db,
      sql`select e.id, e.wallet_id, e.kind, e.cash_delta from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
          where w.season_id = ${seasonId} and e.kind in (${sql.join(PAGAMENTOS.map((k) => sql`${k}`), sql`, `)}) and e.cash_delta <> 0
            and not exists (select 1 from futbolsa.payout_credits pc where pc.entry_id = e.id and pc.wallet_id = e.wallet_id and pc.amount = e.cash_delta)`,
    );
    const creditoSemLinha = await linhas(
      db,
      sql`select pc.event_id, pc.wallet_id, pc.amount, e.cash_delta, e.kind from futbolsa.payout_credits pc
          join futbolsa.payout_events pe on pe.id = pc.event_id
          left join futbolsa.wallet_entries e on e.id = pc.entry_id
          where pe.season_id = ${seasonId} and (e.id is null or e.cash_delta <> pc.amount or e.wallet_id <> pc.wallet_id)`,
    );
    return [
      ...semCredito.map((x) => `linha ${x.id} (${x.kind}) da carteira ${x.wallet_id} pagou ${x.cash_delta} centavos sem crédito em payout_credits`),
      ...creditoSemLinha.map((x) => `crédito do evento ${x.event_id} na carteira ${x.wallet_id} é ${x.amount}, mas a linha do extrato diz ${x.cash_delta ?? "nada"}`),
    ];
  });
  await c.checar("abertura de R$ 100.000,00 por carteira", async () => {
    const r = await linhas(
      db,
      sql`select w.id, w.owner_type, count(e.id)::int as linhas, coalesce(sum(e.cash_delta), 0)::bigint as valor
          from futbolsa.wallets w left join futbolsa.wallet_entries e on e.wallet_id = w.id and e.kind = 'initial'
          where w.season_id = ${seasonId}
          group by w.id
          having (w.owner_type <> 'treasury' and (count(e.id) <> 1 or coalesce(sum(e.cash_delta), 0) <> ${ENTRY_TOTAL}))
              or (w.owner_type = 'treasury' and count(e.id) <> 0)`,
    );
    return r.map((x) => `carteira ${x.id} (${x.owner_type}) tem ${x.linhas} linha(s) de abertura somando ${reais(Number(x.valor))}`);
  });
  await c.checar("emissão da entrada no meio paga pelo preço das ações", async () => {
    const r = await linhas(
      db,
      sql`select e.id, e.wallet_id, w.owner_type, e.cash_delta, e.shares_delta, e.price
          from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
          where w.season_id = ${seasonId} and e.kind = 'index_entry'
            and e.cash_delta <> case when w.owner_type = 'treasury' then 0 else -e.shares_delta * coalesce(e.price, 0) end`,
    );
    return r.map((x) => `linha ${x.id} da carteira ${x.wallet_id}: ${x.shares_delta} ações a ${reais(Number(x.price))} com caixa ${x.cash_delta}`);
  });
  return { caixaTotal, explicado };
}

// ---------------------------------------------------------------------------------------------------------------------
// (c) ações de cada clube

async function conferirAcoes(db: Leitor, seasonId: number, c: Coletor): Promise<void> {
  await c.checar("ações do clube = oferta + lote + emitidas (livro 30, ipo 23)", async () => {
    const r = await linhas(
      db,
      sql`select cl.ticker, sc.total_shares, s.offer_size, r.club_id is not null as liquidado,
            r.treasury_shares, r.mm_lot_shares, coalesce(al.alocadas, 0)::bigint as alocadas, coalesce(ix.emitidas, 0)::bigint as emitidas
          from futbolsa.season_clubs sc
          join futbolsa.clubs cl on cl.id = sc.club_id
          join futbolsa.seasons s on s.id = sc.season_id
          left join futbolsa.ipo_results r on r.season_id = sc.season_id and r.club_id = sc.club_id
          left join lateral (
            select sum(a.shares) as alocadas from futbolsa.ipo_allocations a join futbolsa.ipo_bids b on b.id = a.bid_id
            where b.season_id = sc.season_id and b.club_id = sc.club_id) al on true
          left join lateral (
            select sum(e.shares_delta) as emitidas from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
            where w.season_id = sc.season_id and e.club_id = sc.club_id and e.kind = 'index_entry') ix on true
          where sc.season_id = ${seasonId}
            and ((r.club_id is null and sc.total_shares <> 0)
              or (r.club_id is not null and (
                    sc.total_shares <> s.offer_size + r.mm_lot_shares + coalesce(ix.emitidas, 0)
                    or coalesce(al.alocadas, 0) + r.treasury_shares <> s.offer_size)))`,
    );
    return r.map((x) =>
      x.liquidado
        ? `clube ${x.ticker}: total ${x.total_shares}, mas oferta ${x.offer_size} + lote ${x.mm_lot_shares} + emitidas ${x.emitidas} = ${Number(x.offer_size) + Number(x.mm_lot_shares) + Number(x.emitidas)} (alocadas ${x.alocadas} + sobra da tesouraria ${x.treasury_shares})`
        : `clube ${x.ticker}: total ${x.total_shares} antes da liquidação do IPO (devia ser 0)`,
    );
  });
  await c.checar("ações somadas nas carteiras = total do clube, e zero depois da recompra (livro 30)", () => assertSharesConserved(db as Database, seasonId));
}

// ---------------------------------------------------------------------------------------------------------------------
// (e) caixa negativo

async function conferirCaixaNegativo(db: Leitor, seasonId: number, c: Coletor): Promise<void> {
  await c.checar("nenhum caixa negativo sem estorno (admin 15)", async () => {
    const carteiras = await linhas(
      db,
      sql`select w.id, w.owner_type, w.cash from futbolsa.wallets w
          where w.season_id = ${seasonId} and w.cash < 0
            and not exists (select 1 from futbolsa.wallet_entries e where e.wallet_id = w.id and e.kind in ('reversal', 'trade_annulled') and e.cash_delta < 0)`,
    );
    const linhasRuins = await linhas(
      db,
      sql`select e.id, e.wallet_id, e.kind, e.cash_delta, e.cash_after from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
          where w.season_id = ${seasonId} and e.cash_after < 0 and e.cash_delta < 0 and e.kind not in ('reversal', 'trade_annulled')`,
    );
    return [
      ...carteiras.map((x) => `carteira ${x.id} (${x.owner_type}) com caixa ${reais(Number(x.cash))} sem nenhum estorno`),
      ...linhasRuins.map((x) => `linha ${x.id} (${x.kind}) levou a carteira ${x.wallet_id} a ${reais(Number(x.cash_after))} (só estorno e anulação podem)`),
    ];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// (d) reservas

async function conferirReservas(db: Leitor, seasonId: number, c: Coletor): Promise<void> {
  await c.checar("reservas = ordens abertas + ofertas do IPO", () => assertReservesMatchOrders(db as Database, seasonId));
  await c.checar("oferta ativa do IPO reserva quantidade × preço máximo", async () => {
    const r = await linhas(
      db,
      sql`select b.id, b.wallet_id, b.quantity, b.max_price, b.reserved from futbolsa.ipo_bids b
          where b.season_id = ${seasonId} and b.status = 'active' and b.reserved <> b.quantity::bigint * b.max_price`,
    );
    return r.map((x) => `oferta ${x.id} da carteira ${x.wallet_id}: ${x.quantity} × ${reais(Number(x.max_price))} reservando ${reais(Number(x.reserved))}`);
  });
  await c.checar("contador de ordens abertas", () => assertOpenOrdersCounter(db as Database, seasonId));
}

// ---------------------------------------------------------------------------------------------------------------------
// (g) patrimônio do estado

/**
 * O patrimônio de cada carteira de jogador e bot lido do **estado de agora** (não do histórico): caixa + ações × preço exibido
 * (`last_price`, ou o do IPO) + o a receber das tabelas de pagamento (ações da foto × valor por ação dos eventos vigentes já
 * fechados, menos o já creditado em todas as versões da mesma chave); com a recompra fechada, as ações valem zero. Conta o caixa
 * reservado (rankings 14) e o caixa negativo (rankings 13).
 */
export async function patrimonioDoEstado(db: Leitor, seasonId: number, em: Date): Promise<Map<number, number>> {
  const iso = em.toISOString();
  const r = await linhas(
    db,
    sql`with precos as (
          select sc.club_id, coalesce(sc.last_price, sc.ipo_price, 0) as preco from futbolsa.season_clubs sc where sc.season_id = ${seasonId}),
        acoes as (
          select p.wallet_id, sum(p.shares::bigint * pr.preco) as valor
          from futbolsa.positions p join precos pr on pr.club_id = p.club_id group by p.wallet_id),
        devido as (
          select h.wallet_id, sum(h.shares::bigint * pe.per_share) as valor
          from futbolsa.payout_events pe join futbolsa.payout_holdings h on h.event_id = pe.id
          where pe.season_id = ${seasonId} and pe.status <> 'superseded' and pe.closed_at <= ${iso}::timestamptz
          group by h.wallet_id),
        pago as (
          select pc.wallet_id, sum(pc.amount) as valor
          from futbolsa.payout_credits pc join futbolsa.payout_events pe on pe.id = pc.event_id
          where pe.season_id = ${seasonId} and exists (
            select 1 from futbolsa.payout_events cur where cur.season_id = pe.season_id and cur.club_id = pe.club_id
              and cur.event_key = pe.event_key and cur.status <> 'superseded' and cur.closed_at <= ${iso}::timestamptz)
          group by pc.wallet_id)
        select w.id,
          (w.cash
            + case when s.trading_ended_at is not null and s.trading_ended_at <= ${iso}::timestamptz then 0 else coalesce(a.valor, 0) end
            + coalesce(d.valor, 0) - coalesce(pg.valor, 0))::bigint as patrimonio
        from futbolsa.wallets w
        join futbolsa.seasons s on s.id = w.season_id
        left join acoes a on a.wallet_id = w.id
        left join devido d on d.wallet_id = w.id
        left join pago pg on pg.wallet_id = w.id
        where w.season_id = ${seasonId} and w.owner_type <> 'treasury'`,
  );
  return new Map(r.map((x) => [Number(x.id), Number(x.patrimonio)]));
}

function diferencas(nomeA: string, a: Map<number, number>, nomeB: string, b: Map<number, number>, ids?: Iterable<number>): string[] {
  const out: string[] = [];
  for (const id of ids ?? new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(id);
    const vb = b.get(id);
    if (va !== vb) out.push(`carteira ${id}: ${nomeA} ${va === undefined ? "ausente" : reais(va)}, ${nomeB} ${vb === undefined ? "ausente" : reais(vb)}`);
  }
  return out;
}

/** É a parada das 23h59 de Brasília do último dia do mês? Devolve o mês (`yyyy-mm`) ou `null`. */
export function fimDoMesDe(em: Date): string | null {
  const chave = monthKey(em.getTime());
  return closeAtOfMonth(chave).getTime() === em.getTime() ? chave : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// o dia

/**
 * Confere as invariantes depois de um dia simulado (veja o topo do arquivo). `parada.em` é o relógio simulado da parada. Na
 * parada das 23h59 do fim do mês, lê o patrimônio de cada carteira do estado, confere com o do histórico (`EquityAt`) e guarda
 * em `estado.patrimonioFimDoMes`. Falha com `ViolacoesDeInvariantes` (todas as do dia juntas).
 */
export async function verificarDia(
  alvo: AlvoVerificador,
  seasonId: number,
  parada: { em: Date },
  estado: EstadoVerificador = novoEstadoVerificador(),
  opcoes: OpcoesVerificador = {},
): Promise<RelatorioDia> {
  const c = new Coletor();
  const { caixaTotal, explicado, fimDoMes } = await lendo(alvo, async (db, tx) => {
    // (a) o extrato da F4 (carteira 19)
    await c.checar("carteira e posições = soma do extrato (carteira 19)", () => assertLedgerConsistent(db as Database, seasonId));
    // (b)
    const dinheiro = await conferirDinheiro(db, seasonId, c);
    // (c)
    await conferirAcoes(db, seasonId, c);
    // (d)
    await conferirReservas(db, seasonId, c);
    // (e)
    await conferirCaixaNegativo(db, seasonId, c);
    // (f)
    await c.checar("candles iguais aos negócios", () => assertCandlesMatchTrades(db as Database, seasonId));
    // (g)
    const mes = fimDoMesDe(parada.em);
    if (mes) {
      const doEstado = await patrimonioDoEstado(db, seasonId, parada.em);
      await c.checar(`patrimônio do estado = patrimônio pelo histórico às 23h59 de ${mes} (rankings 1, 13, 14)`, async () => {
        const historico = new Map([...(await EquityAt.forSeason(tx, seasonId, parada.em)).values()].map((e) => [e.walletId, e.equity]));
        return diferencas("pelo estado", doEstado, "pelo histórico", historico);
      });
      estado.patrimonioFimDoMes.set(mes, doEstado);
    }
    // o relógio
    if (opcoes.relogio !== false) {
      await c.checar("detector de relógio real", async () => {
        const [s] = await linhas(db, sql`select year from futbolsa.seasons where id = ${seasonId}`);
        const achados = await procurarRelogioReal(db, Number(s!.year), parada.em, { agoraReal: opcoes.agoraReal });
        return achados.map(descreverAchado);
      });
    }
    return { ...dinheiro, fimDoMes: mes };
  });
  estado.dias++;
  estado.ultimo = { em: parada.em, caixaTotal, explicado };
  if (c.violacoes.length > 0) throw new ViolacoesDeInvariantes(parada.em, c.violacoes);
  return { em: parada.em, conferidas: c.conferidas, caixaTotal, fimDoMes };
}

// ---------------------------------------------------------------------------------------------------------------------
// (h) o fim

export interface ComparacaoRankings {
  /** Os rankings oficiais conferidos (`month:2025-03`, `season:2025`). */
  rankings: string[];
  /** Quantas linhas (carteira × ranking) foram comparadas. */
  linhas: number;
  /** Os meses do estado (23h59) comparados com o histórico. */
  mesesDoEstado: string[];
}

/**
 * No fim do ensaio (Rankings 1, 13 e 14 da F13): para cada ranking oficial fechado (versão atual), o patrimônio gravado de cada
 * linha tem de ser igual ao recalculado pelo histórico no instante do fechamento ("estado de hoje menos o que veio depois de T",
 * `equityAtWallets`) e, nos meses lidos às 23h59, igual ao patrimônio do estado guardado em `estado.patrimonioFimDoMes`. Também
 * compara o estado de cada mês guardado com o histórico de agora, carteira por carteira (bots inclusive). Só vale quando nada
 * foi corrigido depois (estorno, anulação): aí o ranking muda de versão e o estado de 23h59 fica velho, de propósito.
 */
export async function compararRankingOficialComRecalculado(
  alvo: AlvoVerificador,
  seasonId: number,
  estado?: EstadoVerificador,
): Promise<ComparacaoRankings> {
  const c = new Coletor();
  const out: ComparacaoRankings = { rankings: [], linhas: 0, mesesDoEstado: [] };
  await lendo(alvo, async (db, tx) => {
    const cabecas = await linhas(
      db,
      sql`select distinct on (period, period_key) id, period, period_key, closed_at, version
          from futbolsa.ranking_snapshots where season_id = ${seasonId}
          order by period, period_key, version desc`,
    );
    for (const cab of cabecas) {
      const nome = `${cab.period}:${cab.period_key}`;
      out.rankings.push(nome);
      const closedAt = cab.closed_at instanceof Date ? cab.closed_at : new Date(String(cab.closed_at));
      const rows = await linhas(db, sql`select wallet_id, equity from futbolsa.ranking_rows where snapshot_id = ${cab.id}`);
      const oficial = new Map(rows.map((r) => [Number(r.wallet_id), Number(r.equity)]));
      out.linhas += oficial.size;
      await c.checar(`ranking oficial ${nome} (versão ${cab.version}) = recalculado pelo histórico (rankings 13)`, async () => {
        const recalc = await equityAtWallets(tx, seasonId, closedAt, [...oficial.keys()]);
        return diferencas("oficial", oficial, "recalculado", new Map([...recalc].map(([id, e]) => [id, e.equity])), oficial.keys());
      });
      const doEstado = cab.period === "month" ? estado?.patrimonioFimDoMes.get(String(cab.period_key)) : undefined;
      if (doEstado) {
        await c.checar(`ranking oficial ${nome} = patrimônio do estado às 23h59 (rankings 1, 14)`, async () =>
          diferencas("oficial", oficial, "do estado", doEstado, oficial.keys()),
        );
      }
    }
    for (const [mes, doEstado] of estado?.patrimonioFimDoMes ?? []) {
      out.mesesDoEstado.push(mes);
      await c.checar(`patrimônio do estado às 23h59 de ${mes} = histórico de agora`, async () => {
        const historico = new Map([...(await EquityAt.forSeason(tx, seasonId, closeAtOfMonth(mes))).values()].map((e) => [e.walletId, e.equity]));
        return diferencas("do estado", doEstado, "pelo histórico", historico);
      });
    }
  });
  if (c.violacoes.length > 0) throw new ViolacoesDeInvariantes(new Date(), c.violacoes);
  return out;
}
