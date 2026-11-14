import { sql, TransactionRollbackError } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgenteDeBots, ligarBots } from "../../ensaio/bots.js";
import { Condutor, HORA } from "../../ensaio/condutor.js";
import { carregarTemporada2025, type Carregado } from "../../ensaio/carregar.js";
import { detectarRelogioReal, FUTURAS_PERMITIDAS, procurarRelogioReal, RELOGIO_REAL_CONHECIDO } from "../../ensaio/detector-relogio.js";
import {
  compararRankingOficialComRecalculado,
  type EstadoVerificador,
  fimDoMesDe,
  novoEstadoVerificador,
  verificarDia,
} from "../../ensaio/invariantes.js";
import { criarServidorEnsaio, type ServidorEnsaio } from "../../ensaio/servidor.js";
import type { DrizzleTx } from "../../src/infra/db/index.js";
import { closeAtOfMonth } from "../../src/modules/rankings/base.js";
import { createTestDatabase, type TestDatabase } from "../support/db.js";
import { rng } from "../support/fixtures.js";

/**
 * O verificador de invariantes e o detector de relógio real (T8 do Plano do ensaio). Um mundo saudável (a temporada de 2025 com os
 * 9 perfis de bot, do IPO ao fim de março) passa todos os dias; depois, cada `it` estraga o banco de propósito dentro de uma
 * transação, confere que o verificador acusa com a mensagem certa e desfaz (`rollback`), então o próximo `it` vê o mundo
 * saudável de novo.
 */
describe("verificador de invariantes e detector de relógio (T8)", () => {
  let banco: TestDatabase;
  let servidor: ServidorEnsaio;
  let carga: Carregado;
  let condutor: Condutor;
  const estado: EstadoVerificador = novoEstadoVerificador();
  const fimDeMarco = closeAtOfMonth("2025-03");
  let diasVerificados = 0;

  beforeAll(async () => {
    banco = await createTestDatabase(12);
    servidor = await criarServidorEnsaio({ databaseUrl: banco.url, inicio: new Date("2025-03-01T12:00:00Z"), poolSize: 12 });
    carga = await carregarTemporada2025(servidor, { offerSize: 1000 });
    servidor.clock.set(new Date(carga.ipo.opensAt.getTime() - 24 * HORA));
    // os bots entram nos rankings, para o ranking oficial ter linhas a comparar
    const chave = await servidor.app.inject({
      method: "PATCH",
      url: `/admin/seasons/${carga.seasonId}`,
      payload: { botsInRankings: true, reason: "ensaio: bots nos rankings" },
      headers: await carga.admin.auth(),
    });
    expect(chave.statusCode).toBeLessThan(300);
    await ligarBots(servidor, carga, 0.04);
    const agente = new AgenteDeBots(servidor, rng(3));
    condutor = new Condutor(servidor, carga, {
      sorteio: rng(5),
      ganchos: {
        agir: async (p) => void (await agente.agir(p)),
        // uma vez por dia simulado e na parada das 23h59 do fim do mês
        depois: async (p) => {
          if (!p.novoDia && !fimDoMesDe(p.em)) return;
          await verificarDia(servidor, carga.seasonId, p, estado);
          diasVerificados++;
        },
      },
    });
    // até a parada das 23h59 de 31 de março (inclusive): uns 8 dias depois da abertura da negociação
    await condutor.rodarAte(fimDeMarco);
  }, 1_200_000);

  afterAll(async () => {
    await servidor?.fechar();
    await banco?.close();
  });

  /** Estraga o banco numa transação, roda `conferir` nela e desfaz. Devolve a mensagem do erro (vazia se nada acusou). */
  async function estragado(estrago: (tx: DrizzleTx) => Promise<unknown>, conferir?: (tx: DrizzleTx) => Promise<unknown>): Promise<string> {
    let mensagem = "";
    try {
      await servidor.conexao.db.transaction(async (tx) => {
        await estrago(tx);
        try {
          await (conferir ?? ((t) => verificarDia(t, carga.seasonId, { em: servidor.clock.now() }, novoEstadoVerificador())))(tx);
        } catch (error) {
          mensagem = (error as Error).message;
        }
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
    return mensagem;
  }

  async function uma(tx: DrizzleTx, query: ReturnType<typeof sql>): Promise<Record<string, unknown>> {
    const [linha] = (await tx.execute(query)).rows as Record<string, unknown>[];
    if (!linha) throw new Error("o mundo do teste não tem a linha que o estrago precisa");
    return linha;
  }

  it("carteira 19, livro 30, ipo 23: o mundo saudável passa em todos os dias, com o patrimônio de março lido às 23h59", async () => {
    expect(servidor.clock.now().getTime()).toBe(fimDeMarco.getTime());
    expect(diasVerificados).toBeGreaterThan(10);
    expect(estado.dias).toBe(diasVerificados);
    const marco = estado.patrimonioFimDoMes.get("2025-03");
    expect(marco?.size).toBeGreaterThan(9);
    // dinheiro do jogo: abertura dos bots e pagamentos explicam todo o caixa
    expect(estado.ultimo!.caixaTotal).toBe(estado.ultimo!.explicado);
    const negocios = await servidor.conexao.db.execute(sql`select count(*)::int as n from futbolsa.trades where season_id = ${carga.seasonId}`);
    expect(Number(negocios.rows[0]!.n)).toBeGreaterThan(0);
    // e de novo agora, com o relógio parado (só leitura)
    const dia = await verificarDia(servidor, carga.seasonId, { em: servidor.clock.now() }, novoEstadoVerificador());
    expect(dia.fimDoMes).toBe("2025-03");
  });

  it("carteira 19: R$ 1,00 a menos num caixa (UPDATE direto) acusa o extrato e o dinheiro total", async () => {
    const msg = await estragado(async (tx) => {
      const w = await uma(tx, sql`select id from futbolsa.wallets where season_id = ${carga.seasonId} and owner_type = 'bot' and cash - reserved_cash >= 100 order by id limit 1`);
      await tx.execute(sql`update futbolsa.wallets set cash = cash - 100 where id = ${w.id}`);
    });
    expect(msg).toMatch(/carteira e posições = soma do extrato \(carteira 19\): carteira diferente da soma do extrato/);
    expect(msg).toMatch(/dinheiro total constante.*diferença de -100 centavos/);
  });

  it("livro 30: uma ação a menos numa posição acusa a conservação das ações do clube", async () => {
    const msg = await estragado(async (tx) => {
      const p = await uma(tx, sql`select p.wallet_id, p.club_id from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id
        where w.season_id = ${carga.seasonId} and w.owner_type = 'bot' and p.shares > p.reserved_shares order by p.wallet_id, p.club_id limit 1`);
      await tx.execute(sql`update futbolsa.positions set shares = shares - 1 where wallet_id = ${p.wallet_id} and club_id = ${p.club_id}`);
    });
    expect(msg).toMatch(/ações somadas nas carteiras = total do clube.*ações do clube diferentes do total emitido/);
    expect(msg).toMatch(/posição diferente da soma do extrato/);
  });

  it("ipo 23: o total do clube diferente da oferta + lote + emitidas é acusado com o clube e os números", async () => {
    const msg = await estragado(async (tx) => {
      await tx.execute(sql`update futbolsa.season_clubs set total_shares = total_shares + 1
        where season_id = ${carga.seasonId} and club_id = (select min(club_id) from futbolsa.season_clubs where season_id = ${carga.seasonId})`);
    });
    expect(msg).toMatch(/ações do clube = oferta \+ lote \+ emitidas \(livro 30, ipo 23\): clube \w+: total 1201, mas oferta 1000 \+ lote 200 \+ emitidas 0 = 1200/);
  });

  it("um candle apagado acusa candles diferentes dos negócios", async () => {
    const msg = await estragado(async (tx) => {
      const c = await uma(tx, sql`select club_id, interval, start from futbolsa.candles order by start, club_id, interval limit 1`);
      await tx.execute(sql`delete from futbolsa.candles where club_id = ${c.club_id} and interval = ${c.interval} and start = ${c.start}`);
    });
    expect(msg).toMatch(/candles iguais aos negócios: os candles não batem com os negócios/);
  });

  it("uma reserva de caixa sem ordem acusa as reservas", async () => {
    const msg = await estragado(async (tx) => {
      const w = await uma(tx, sql`select id from futbolsa.wallets where season_id = ${carga.seasonId} and owner_type = 'bot' and cash - reserved_cash >= 100 order by id limit 1`);
      await tx.execute(sql`update futbolsa.wallets set reserved_cash = reserved_cash + 100 where id = ${w.id}`);
    });
    expect(msg).toMatch(/reservas = ordens abertas \+ ofertas do IPO: caixa reservado da carteira diferente das compras abertas e das ofertas do IPO/);
  });

  it("admin 15: caixa negativo sem estorno é acusado com a carteira e o valor", async () => {
    let carteira = 0;
    const msg = await estragado(async (tx) => {
      const w = await uma(tx, sql`select id from futbolsa.wallets where season_id = ${carga.seasonId} and owner_type = 'bot' order by id limit 1`);
      carteira = Number(w.id);
      // sem reserva (o CHECK do banco só deixa caixa negativo sem nada reservado): ordens e reservas ficam erradas também
      await tx.execute(sql`update futbolsa.wallets set cash = -100, reserved_cash = 0 where id = ${w.id}`);
    });
    expect(msg).toMatch(new RegExp(`nenhum caixa negativo sem estorno \\(admin 15\\): carteira ${carteira} \\(bot\\) com caixa R\\$ -1\\.00 sem nenhum estorno`));
  });

  it("rankings 1, 14: patrimônio do estado às 23h59 diferente do histórico (preço exibido mexido) é acusado", async () => {
    const msg = await estragado(async (tx) => {
      await tx.execute(sql`update futbolsa.season_clubs set last_price = last_price + 1
        where season_id = ${carga.seasonId} and club_id = (select min(p.club_id) from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id
          where w.season_id = ${carga.seasonId} and w.owner_type = 'bot' and p.shares > 0)`);
    });
    expect(msg).toMatch(/patrimônio do estado = patrimônio pelo histórico às 23h59 de 2025-03 \(rankings 1, 13, 14\): carteira \d+: pelo estado R\$/);
  });

  it("um now() de verdade numa coluna timestamptz é acusado pelo detector de relógio real", async () => {
    const msg = await estragado(async (tx) => {
      await tx.execute(sql`update futbolsa.orders set updated_at = now() where id = (select min(id) from futbolsa.orders where season_id = ${carga.seasonId})`);
    });
    expect(msg).toMatch(/detector de relógio real: relógio real: orders\.updated_at tem 1 valor\(es\) depois do relógio simulado \+ 1 dia/);
    expect(msg).toMatch(/orders\.updated_at tem 1 valor\(es\) no dia de hoje do relógio real/);
    // e pelo detector sozinho
    const sozinho = await estragado(
      (tx) => tx.execute(sql`insert into futbolsa.admin_log (actor_id, at, action) values (${carga.admin.conta.id}, now(), 'teste')`),
      (tx) => detectarRelogioReal(tx, 2025, servidor.clock.now()),
    );
    expect(sozinho).toMatch(/relógio real: admin_log\.at tem 1 valor\(es\) depois do relógio simulado/);
  });

  it("o detector deixa as datas agendadas no futuro (FUTURAS_PERMITIDAS) e acusa as de antes do ano do ensaio", async () => {
    const db = servidor.conexao.db;
    // o calendário tem jogos até dezembro, bem depois do relógio de março: não é vazamento
    const futuros = await db.execute(sql`select count(*)::int as n from futbolsa.matches where kickoff > ${new Date(servidor.clock.now().getTime() + 24 * HORA).toISOString()}::timestamptz`);
    expect(Number(futuros.rows[0]!.n)).toBeGreaterThan(0);
    expect(FUTURAS_PERMITIDAS).toHaveProperty(["matches.kickoff"]);
    expect(await procurarRelogioReal(db, 2025, servidor.clock.now())).toEqual([]);
    // os vazamentos conhecidos (registro sem regra) continuam visíveis no modo estrito
    const estritos = await procurarRelogioReal(db, 2025, servidor.clock.now(), { estrito: true });
    expect(new Set(estritos.map((a) => `${a.tabela}.${a.coluna}`))).toEqual(new Set(Object.keys(RELOGIO_REAL_CONHECIDO)));
    const antigo = await estragado(
      (tx) => tx.execute(sql`update futbolsa.orders set created_at = to_timestamp(0) where id = (select min(id) from futbolsa.orders where season_id = ${carga.seasonId})`),
      (tx) => detectarRelogioReal(tx, 2025, servidor.clock.now()),
    );
    expect(antigo).toMatch(/orders\.created_at tem 1 valor\(es\) antes do ano anterior ao do ensaio \(ex\.: 1970-01-01/);
  });

  it("o verificador só lê: com o servidor, uma escrita no meio dele seria recusada pelo banco", async () => {
    const antes = await servidor.conexao.db.execute(sql`select count(*)::int as n, coalesce(sum(cash), 0)::bigint as caixa from futbolsa.wallets`);
    await verificarDia(servidor, carga.seasonId, { em: servidor.clock.now() }, novoEstadoVerificador());
    const depois = await servidor.conexao.db.execute(sql`select count(*)::int as n, coalesce(sum(cash), 0)::bigint as caixa from futbolsa.wallets`);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });

  describe("depois do fechamento de março", () => {
    beforeAll(async () => {
      // a tarefa fecha o mês com a folga de 5 minutos: na parada das 3h de 1º de abril
      await condutor.rodarAte(new Date(fimDeMarco.getTime() + 6 * HORA));
    }, 600_000);

    it("rankings 13: o ranking oficial de março, o recalculado pelo histórico e o patrimônio do estado às 23h59 dão os mesmos valores", async () => {
      const r = await compararRankingOficialComRecalculado(servidor, carga.seasonId, estado);
      expect(r.rankings).toContain("month:2025-03");
      expect(r.linhas).toBeGreaterThan(9);
      expect(r.mesesDoEstado).toEqual(["2025-03"]);
    });

    it("rankings 13: uma versão do ranking oficial com um centavo a mais numa linha é acusada", async () => {
      const msg = await estragado(
        async (tx) => {
          const cab = await uma(tx, sql`select id, closed_at, bots_included, version from futbolsa.ranking_snapshots
            where season_id = ${carga.seasonId} and period = 'month' and period_key = '2025-03' order by version desc limit 1`);
          const [nova] = (
            await tx.execute(sql`insert into futbolsa.ranking_snapshots (season_id, period, period_key, closed_at, bots_included, version, reason, created_at)
              values (${carga.seasonId}, 'month', '2025-03', ${cab.closed_at}, ${cab.bots_included}, ${Number(cab.version) + 1}, 'estrago do teste', ${servidor.clock.now().toISOString()})
              returning id`)
          ).rows as Array<{ id: number }>;
          await tx.execute(sql`insert into futbolsa.ranking_rows (snapshot_id, wallet_id, base, equity, position)
            select ${nova!.id}, wallet_id, base, equity + case when position = 1 then 1 else 0 end, position from futbolsa.ranking_rows where snapshot_id = ${cab.id}`);
        },
        (tx) => compararRankingOficialComRecalculado(tx, carga.seasonId, estado),
      );
      expect(msg).toMatch(/ranking oficial month:2025-03 \(versão 2\) = recalculado pelo histórico \(rankings 13\): carteira \d+: oficial R\$ [\d.-]+, recalculado R\$/);
      expect(msg).toMatch(/ranking oficial month:2025-03 = patrimônio do estado às 23h59 \(rankings 1, 14\)/);
    });
  });
});
