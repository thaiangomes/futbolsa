import { Module } from "@nestjs/common";
import { AdminLogModule } from "../admin/log/index.js";
import { RealtimeModule } from "../../infra/realtime/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { MarketMakerAdminController } from "./admin/market-maker.controller.js";
import { MarketMakerAdminService } from "./admin/market-maker.service.js";
import { BookController } from "./book/book.controller.js";
import { BookReadService } from "./book/book-read.service.js";
import { MatchingEngine } from "./matching/matching-engine.js";
import { PostgresMatchingEngine } from "./matching/postgres-matching-engine.js";
import { OrderService } from "./orders/order.service.js";
import { BookPublisher } from "./realtime/book-publisher.js";
import { MarketEvents } from "./realtime/events.js";

/**
 * Mercado secundário (F9: livro de ofertas e formador de mercado). Por enquanto, o motor de ordens: a porta
 * `MatchingEngine` ligada à implementação do Postgres e o `OrderService`, a entrada das ordens de jogadores, bots
 * e da casa. As rotas, o cancelamento, os eventos e o formador chegam nas tarefas seguintes.
 *
 * Túnel de preço: a ordem que sairia do túnel abre o leilão (L4). Quem fecha o leilão vencido é o `AuctionCloser`
 * (`state/tunnel-state.ts`), que o `OrderService` recebe como dependência opcional: a L5 o liga aqui com
 * `{ provide: AuctionCloser, useClass: … }`. Enquanto ele não existe, a ordem que encontra um leilão vencido é erro.
 */
@Module({
  imports: [PortfolioModule, AdminLogModule, RealtimeModule],
  controllers: [MarketMakerAdminController, BookController],
  providers: [{ provide: MatchingEngine, useClass: PostgresMatchingEngine }, OrderService, MarketMakerAdminService, BookReadService, BookPublisher, MarketEvents],
  exports: [OrderService, MarketEvents, BookPublisher],
})
export class MarketModule {}
