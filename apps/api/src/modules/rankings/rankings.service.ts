import { Inject, Injectable } from "@nestjs/common";
import { DB, type Database, withTransaction } from "../../infra/db/index.js";
import type { Tx } from "../../infra/db/transaction.js";
import { CloseService } from "./close.service.js";
import { equityAtWallets, type RankingEquity } from "./equity-at.js";
import { RecalcService } from "./recalc.service.js";
import { currentRowsOf, type Period, type StoredRow } from "./snapshots.js";

/**
 * A porta do módulo para os outros (F15, F16 e F14): fechar o mês e o ano, pedir e atender o recálculo, ler as linhas
 * atuais de um ranking e o patrimônio pelo histórico (o verificador da F16 o compara com o estado).
 */
@Injectable()
export class RankingsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly close: CloseService,
    private readonly recalc: RecalcService,
  ) {}

  closeMonth = (...args: Parameters<CloseService["closeMonth"]>) => this.close.closeMonth(...args);
  closeSeason = (...args: Parameters<CloseService["closeSeason"]>) => this.close.closeSeason(...args);
  closeMonthsDue = (...args: Parameters<CloseService["closeMonthsDue"]>) => this.close.closeMonthsDue(...args);
  requestRecalc = (...args: Parameters<RecalcService["requestRecalc"]>) => this.recalc.requestRecalc(...args);
  processRecalcRequests = (...args: Parameters<RecalcService["processRecalcRequests"]>) => this.recalc.processRecalcRequests(...args);
  pendingRecalc = (...args: Parameters<RecalcService["pendingRecalc"]>) => this.recalc.pendingRecalc(...args);

  /** As linhas da versão atual de um ranking oficial (para o `GET /me/history` da F15), por carteira; `null` se não fechou. */
  currentRows(tx: Pick<Tx, "db">, seasonId: number, period: Period, periodKey: string): Promise<Map<number, StoredRow> | null> {
    return currentRowsOf(tx, seasonId, period, periodKey);
  }

  /** O patrimônio de cada carteira em `at`, pelo histórico (leitura numa transação própria). */
  equityAt(seasonId: number, at: Date, walletIds: readonly number[]): Promise<Map<number, RankingEquity>> {
    return withTransaction(this.db, (tx) => equityAtWallets(tx, seasonId, at, walletIds), { isolationLevel: "repeatable read", readOnly: true });
  }
}
