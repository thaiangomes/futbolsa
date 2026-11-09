import { Module, type OnModuleInit } from "@nestjs/common";
import { AccountClosureHooks, AccountsModule } from "../accounts/index.js";
import { AdminLogModule } from "../admin/log/index.js";
import { DividendsModule } from "../dividends/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { IpoBidsController } from "./bids.controller.js";
import { IpoBidsService } from "./bids.service.js";
import { IpoClosingService } from "./closing.service.js";
import { IpoClosureHook } from "./closure-hook.js";
import { IpoOpeningService } from "./opening.service.js";
import { IpoSettlementService } from "./settlement.service.js";

/**
 * IPO por bookbuilding (F8): abrir as ofertas na data, com as faixas e os R$ 100 mil, as ofertas com
 * reserva, fechar ou adiar o fechamento e liquidar clube a clube. O `admin` importa este módulo (a visão
 * geral mostra por que o IPO não abriu; o `PATCH` da temporada adia o fechamento); este módulo nunca
 * importa o `admin` de volta, só o registro do admin (`AdminLogModule`), que o adiamento grava.
 *
 * Na subida, registra no `accounts` o gancho de encerramento das ofertas (`IpoClosureHook`), que a
 * exclusão (F5) e o bloqueio (F14) chamam. O `accounts` não importa este módulo: a dependência fica
 * num sentido só.
 */
@Module({
  imports: [AccountsModule, PortfolioModule, DividendsModule, AdminLogModule],
  controllers: [IpoBidsController],
  providers: [IpoOpeningService, IpoBidsService, IpoClosingService, IpoSettlementService, IpoClosureHook],
  exports: [IpoOpeningService, IpoBidsService, IpoClosingService, IpoSettlementService, IpoClosureHook],
})
export class IpoModule implements OnModuleInit {
  constructor(
    private readonly closureHooks: AccountClosureHooks,
    private readonly closureHook: IpoClosureHook,
  ) {}

  onModuleInit(): void {
    this.closureHooks.register(this.closureHook);
  }
}
