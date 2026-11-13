import { Injectable, Module } from "@nestjs/common";
import type { Tx } from "../../infra/db/transaction.js";
import { RealtimeModule } from "../../infra/realtime/index.js";
import { recordTrade } from "./candles/record-trade.js";
import { CandlesController } from "./candles/candles.controller.js";
import { CandlesService } from "./candles/candles.service.js";
import { EquityController } from "./daily/equity.controller.js";
import { EquityDailyService } from "./daily/equity-daily.service.js";
import { EntriesController } from "./entries/entries.controller.js";
import { EntriesService } from "./entries/entries.service.js";
import { MarkersController, MyTradesController } from "./markers/markers.controller.js";
import { MarkersService } from "./markers/markers.service.js";
import { SnapshotService } from "./snapshots/snapshot.service.js";
import { WalletController } from "./wallet/wallet.controller.js";
import { WalletService } from "./wallet/wallet.service.js";
import { WalletEvents } from "./wallet-events.js";
import { openWallet, post, postMany, type Movement, type OpenWallet } from "./ledger/index.js";

/**
 * O único caminho de escrita das carteiras, para os outros módulos: eles decidem
 * quanto e chamam `post` dentro da própria transação, com a carteira travada.
 */
@Injectable()
export class PortfolioLedger {
  post(tx: Tx, movement: Movement) {
    return post(tx, movement);
  }

  /** Vários movimentos da mesma carteira (travada) de uma vez, com o resultado de um laço de `post` em ~5 comandos. */
  postMany(tx: Tx, movements: readonly Movement[]) {
    return postMany(tx, movements);
  }

  openWallet(tx: Tx, options: OpenWallet) {
    return openWallet(tx, options);
  }

  /** Atualiza os candles de 15 minutos e do dia com um negócio (o `market` chama a cada negócio). */
  recordTrade(tx: Tx, trade: Parameters<typeof recordTrade>[1]) {
    return recordTrade(tx, trade);
  }
}

/**
 * Carteira e gráficos. A F4 traz o `PortfolioLedger`; a F10 traz as leituras (carteira, extrato, candles, marcadores,
 * patrimônio diário e foto mensal) e o `EquityAt`, o patrimônio num instante que os rankings (F13) reaproveitam.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [WalletController, EntriesController, CandlesController, MarkersController, MyTradesController, EquityController],
  providers: [PortfolioLedger, WalletEvents, WalletService, EntriesService, CandlesService, MarkersService, EquityDailyService, SnapshotService],
  exports: [PortfolioLedger, WalletEvents, WalletService, EntriesService, EquityDailyService, SnapshotService],
})
export class PortfolioModule {}
