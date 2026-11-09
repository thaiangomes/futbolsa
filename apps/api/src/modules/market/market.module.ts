import { Module } from "@nestjs/common";
import { PortfolioModule } from "../portfolio/index.js";
import { MatchingEngine } from "./matching/matching-engine.js";
import { PostgresMatchingEngine } from "./matching/postgres-matching-engine.js";
import { OrderService } from "./orders/order.service.js";

/**
 * Mercado secundário (F9: livro de ofertas e formador de mercado). Por enquanto, o motor de ordens: a porta
 * `MatchingEngine` ligada à implementação do Postgres e o `OrderService`, a entrada das ordens de jogadores, bots
 * e da casa. As rotas, o cancelamento, os eventos e o formador chegam nas tarefas seguintes.
 */
@Module({
  imports: [PortfolioModule],
  providers: [{ provide: MatchingEngine, useClass: PostgresMatchingEngine }, OrderService],
  exports: [OrderService],
})
export class MarketModule {}
