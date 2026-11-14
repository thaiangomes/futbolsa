import { it } from "vitest";
import { eventsResultOf } from "../src/modules/admin/payouts/close-events.service.js";
import { EngineInputService } from "../src/modules/admin/payouts/engine-input.js";
import { BuybackCloseService } from "../src/modules/admin/payouts/buyback-close.service.js";
import { CloseEventsService } from "../src/modules/admin/payouts/close-events.service.js";
import { ImportRunner } from "../src/modules/admin/results/import-runner.js";
import { Condutor, DIA } from "./condutor.js";
import { criarConta } from "./contas.js";
import { criarServidorEnsaio } from "./servidor.js";

/** Diagnóstico: por que a recompra não fechou no ensaio completo? ENSAIO_BANCO = nome do banco mantido. */
it("diagnóstico das datas de fechamento", async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${process.env.ENSAIO_BANCO}`;
  const servidor = await criarServidorEnsaio({ databaseUrl: url.toString(), inicio: new Date("2026-01-31T00:00:00Z"), poolSize: 3 });
  try {
    const input = servidor.app.get(EngineInputService, { strict: false });
    const loaded = await input.load(servidor.conexao.db as never, 1);
    console.log("FECHAMENTOS", JSON.stringify(eventsResultOf(loaded).closes), "tradingEndedAt", loaded.tradingEndedAt);
    servidor.clock.set(new Date("2026-01-31T00:00:00Z"));
    console.log("ISDUE", BuybackCloseService.isDue(loaded, servidor.clock.now()), JSON.stringify((await servidor.conexao.db.execute("select status, trading_ended_at from futbolsa.seasons" as never)).rows));
    try {
      const r = await servidor.app.get(BuybackCloseService, { strict: false }).closeIfDue(1, loaded, servidor.clock.now());
      console.log("FECHAR", JSON.stringify(r));
    } catch (e) {
      console.log("FECHAR ERRO", (e as Error).stack?.slice(0, 900));
    }
    const imp = servidor.app.get(ImportRunner, { strict: false });
    console.log("IMPORT", JSON.stringify([...(await imp.runCalendarIfStale()), ...(await imp.runScores())].map((r) => ({ c: r.competition, k: r.kind, e: r.error }))).slice(0, 700));
    const resumo = await servidor.app.get(CloseEventsService, { strict: false }).closeEvents(1, servidor.clock.now());
    console.log("STATUS", JSON.stringify((await servidor.conexao.db.execute("select status, trading_ended_at from futbolsa.seasons" as never)).rows), JSON.stringify((await servidor.conexao.db.execute("select kind,status,count(*) from futbolsa.payout_events group by 1,2 order by 1,2" as never)).rows));
    const admin = await criarConta(servidor.conexao.db, servidor, { nickname: "admin_diag", role: "admin" });
    const d = new Date(0);
    const carga = { seasonId: 1, year: 2025, admin, clubIds: new Map(), tickers: [], firstKickoff: d, ipo: { opensAt: d, closesAt: d, tradingOpensAt: d }, offerSize: 0 };
    const condutor = new Condutor(servidor, carga as never, {});
    await condutor.rodarAte(new Date(servidor.clock.now().getTime() + 3 * DIA));
    const fim = await servidor.app.inject({ method: "POST", url: "/admin/seasons/1/close", payload: { confirmYear: 2025 }, headers: await admin.auth() });
    console.log("ENCERRAR", fim.statusCode, fim.body.slice(0, 400));
    console.log("STATUS2", JSON.stringify((await servidor.conexao.db.execute("select status from futbolsa.seasons" as never)).rows), JSON.stringify((await servidor.conexao.db.execute("select kind,status,count(*) from futbolsa.payout_events where kind = 'buyback' group by 1,2" as never)).rows));
    console.log("PASSADA", JSON.stringify(resumo).slice(0, 900));
  } finally {
    await servidor.fechar();
  }
});
