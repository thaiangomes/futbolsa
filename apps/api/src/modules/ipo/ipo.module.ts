import { Module } from "@nestjs/common";
import { AccountsModule } from "../accounts/index.js";
import { DividendsModule } from "../dividends/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { IpoOpeningService } from "./opening.service.js";

/**
 * IPO por bookbuilding (F8): abrir as ofertas na data, com as faixas e os R$ 100 mil. O `admin` importa
 * este módulo (a visão geral mostra por que o IPO não abriu); este módulo nunca importa o `admin` de volta.
 */
@Module({
  imports: [AccountsModule, PortfolioModule, DividendsModule],
  providers: [IpoOpeningService],
  exports: [IpoOpeningService],
})
export class IpoModule {}
