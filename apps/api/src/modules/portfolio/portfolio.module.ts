import { Injectable, Module } from "@nestjs/common";
import type { Tx } from "../../infra/db/transaction.js";
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
}

/** Carteira e gráficos. A F4 traz o `PortfolioLedger`; telas e rotas vêm na F10. */
@Module({
  providers: [PortfolioLedger],
  exports: [PortfolioLedger],
})
export class PortfolioModule {}
