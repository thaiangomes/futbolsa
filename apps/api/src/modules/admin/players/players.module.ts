import { Module } from "@nestjs/common";
import { PortfolioModule } from "../../portfolio/index.js";
import { AdminLogModule } from "../log/index.js";
import { AdjustService } from "./adjust.service.js";
import { BlockService } from "./block.service.js";
import { AdminDeleteService } from "./delete.service.js";
import { PlayersController } from "./players.controller.js";
import { PlayersQueryService } from "./players.query.js";

/** Jogadores no admin (F14, T2 a T5): ver, bloquear, excluir e ajustar saldo. O `accounts` é global. */
@Module({
  imports: [AdminLogModule, PortfolioModule],
  controllers: [PlayersController],
  providers: [PlayersQueryService, BlockService, AdminDeleteService, AdjustService],
  exports: [BlockService],
})
export class PlayersModule {}
