import { Module } from "@nestjs/common";
import { AccountsModule } from "../accounts/index.js";
import { DividendsModule } from "../dividends/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { IpoBidsController } from "./bids.controller.js";
import { IpoBidsService } from "./bids.service.js";
import { IpoOpeningService } from "./opening.service.js";

/**
 * IPO por bookbuilding (F8): abrir as ofertas na data, com as faixas e os R$ 100 mil, e as ofertas com
 * reserva. O `admin` importa este módulo (a visão geral mostra por que o IPO não abriu); este módulo
 * nunca importa o `admin` de volta.
 */
@Module({
  imports: [AccountsModule, PortfolioModule, DividendsModule],
  controllers: [IpoBidsController],
  providers: [IpoOpeningService, IpoBidsService],
  exports: [IpoOpeningService, IpoBidsService],
})
export class IpoModule {}
