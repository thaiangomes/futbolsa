import { Injectable, Module } from "@nestjs/common";
import type { Tx } from "../../infra/db/transaction.js";
import { RealtimeModule } from "../../infra/realtime/index.js";
import { recordTrade } from "./candles/record-trade.js";
import { WalletEvents } from "./wallet-events.js";
import { openWallet, post, type Movement, type OpenWallet } from "./ledger/index.js";

/**
 * O único caminho de escrita das carteiras, para os outros módulos: eles decidem
 * quanto e chamam `post` dentro da própria transação, com a carteira travada.
 */
@Injectable()
export class PortfolioLedger {
  post(tx: Tx, movement: Movement) {
    return post(tx, movement);
  }

  openWallet(tx: Tx, options: OpenWallet) {
    return openWallet(tx, options);
  }

  /** Atualiza os candles de 15 minutos e do dia com um negócio (o `market` chama a cada negócio). */
  recordTrade(tx: Tx, trade: Parameters<typeof recordTrade>[1]) {
    return recordTrade(tx, trade);
  }
}

/** Carteira e gráficos. A F4 traz o `PortfolioLedger`; telas e rotas vêm na F10. */
@Module({
  imports: [RealtimeModule],
  providers: [PortfolioLedger, WalletEvents],
  exports: [PortfolioLedger, WalletEvents],
})
export class PortfolioModule {}
