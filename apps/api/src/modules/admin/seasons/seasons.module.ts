import { Module } from "@nestjs/common";
import { DividendsModule } from "../../dividends/dividends.module.js";
import { IpoModule } from "../../ipo/index.js";
import { MarketModule } from "../../market/index.js";
import { PortfolioModule } from "../../portfolio/index.js";
import { RankingsModule } from "../../rankings/index.js";
import { AdminLogModule } from "../log/index.js";
import { PayoutsModule } from "../payouts/payouts.module.js";
import { ClubsController } from "./clubs.controller.js";
import { RulesController } from "./rules.controller.js";
import { RulesService } from "./rules.service.js";
import { SeasonCloseController } from "./season-close.controller.js";
import { SeasonCloseService } from "./season-close.service.js";
import { PublicSeasonController, SeasonsController } from "./seasons.controller.js";
import { SeasonsService } from "./seasons.service.js";

/**
 * Preparar a temporada, valores das ligas e tabelas das copas (T11 a T13). Importa o `IpoModule` para o
 * `PATCH` adiar o fechamento das ofertas (F8, A4). O encerramento (F15, T6) usa os pagamentos (o que falta), os
 * rankings (o fechamento oficial), a carteira (a foto mensal e o livro), o mercado (o aviso `season.status`) e, pelo
 * `AccountsModule` global, o histórico (`SeasonResultsService`). Nenhum desses módulos importa este.
 */
@Module({
  imports: [AdminLogModule, DividendsModule, IpoModule, PayoutsModule, RankingsModule, PortfolioModule, MarketModule],
  controllers: [PublicSeasonController, SeasonsController, RulesController, ClubsController, SeasonCloseController],
  providers: [SeasonsService, RulesService, SeasonCloseService],
  exports: [SeasonsService, RulesService, SeasonCloseService],
})
export class SeasonsModule {}
