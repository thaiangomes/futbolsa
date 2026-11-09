import { Module } from "@nestjs/common";
import { AccountsModule } from "../accounts/index.js";
import { AdminLogModule } from "../admin/log/index.js";
import { DividendsModule } from "../dividends/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { IpoBidsController } from "./bids.controller.js";
import { IpoBidsService } from "./bids.service.js";
import { IpoClosingService } from "./closing.service.js";
import { IpoOpeningService } from "./opening.service.js";

/**
 * IPO por bookbuilding (F8): abrir as ofertas na data, com as faixas e os R$ 100 mil, as ofertas com
 * reserva, e fechar ou adiar o fechamento. O `admin` importa este módulo (a visão geral mostra por que o
 * IPO não abriu; o `PATCH` da temporada adia o fechamento); este módulo nunca importa o `admin` de volta,
 * só o registro do admin (`AdminLogModule`), que o adiamento grava.
 */
@Module({
  imports: [AccountsModule, PortfolioModule, DividendsModule, AdminLogModule],
  controllers: [IpoBidsController],
  providers: [IpoOpeningService, IpoBidsService, IpoClosingService],
  exports: [IpoOpeningService, IpoBidsService, IpoClosingService],
})
export class IpoModule {}
