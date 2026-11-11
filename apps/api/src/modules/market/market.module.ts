import { Module, type OnModuleInit } from "@nestjs/common";
import { AccountClosureHooks } from "../accounts/index.js";
import { AdminLogModule } from "../admin/log/index.js";
import { RealtimeModule } from "../../infra/realtime/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { MarketMakerAdminController } from "./admin/market-maker.controller.js";
import { MarketMakerAdminService } from "./admin/market-maker.service.js";
import { BookController } from "./book/book.controller.js";
import { BookReadService } from "./book/book-read.service.js";
import { MatchingEngine } from "./matching/matching-engine.js";
import { PostgresMatchingEngine } from "./matching/postgres-matching-engine.js";
import { CancelService } from "./orders/cancel.service.js";
import { MarketClosureHook } from "./orders/closure-hook.js";
import { OrderService } from "./orders/order.service.js";
import { OrdersController } from "./orders/orders.controller.js";
import { PlayerOrdersService } from "./orders/player-orders.service.js";
import { BookPublisher } from "./realtime/book-publisher.js";
import { MarketEvents } from "./realtime/events.js";

/**
 * Mercado secundário (F9: livro de ofertas e formador de mercado): a porta `MatchingEngine` ligada à implementação do
 * Postgres e o `OrderService`, a entrada das ordens de jogadores, bots e da casa; o cancelamento (`CancelService`); as
 * rotas das ordens do jogador (`POST`, `GET` e `DELETE /orders`), do livro e do formador; e os eventos.
 *
 * Na subida, registra no `accounts` o gancho de encerramento das ordens (`MarketClosureHook`), que a exclusão (F5) e
 * o bloqueio (F14) chamam. O `accounts` (global) não importa este módulo: a dependência fica num sentido só.
 *
 * Túnel de preço: a ordem que sairia do túnel abre o leilão (L4). Quem fecha o leilão vencido é o `AuctionCloser`
 * (`state/tunnel-state.ts`), que o `OrderService`, o `PlayerOrdersService` e o `CancelService` recebem como
 * dependência opcional: a L5 o liga aqui com `{ provide: AuctionCloser, useClass: … }`. Enquanto ele não existe, a
 * ordem ou o cancelamento que encontra um leilão vencido é erro.
 */
@Module({
  imports: [PortfolioModule, AdminLogModule, RealtimeModule],
  controllers: [MarketMakerAdminController, BookController, OrdersController],
  providers: [
    { provide: MatchingEngine, useClass: PostgresMatchingEngine },
    OrderService,
    CancelService,
    PlayerOrdersService,
    MarketClosureHook,
    MarketMakerAdminService,
    BookReadService,
    BookPublisher,
    MarketEvents,
  ],
  exports: [OrderService, CancelService, MarketEvents, BookPublisher],
})
export class MarketModule implements OnModuleInit {
  constructor(
    private readonly closureHooks: AccountClosureHooks,
    private readonly closureHook: MarketClosureHook,
  ) {}

  onModuleInit(): void {
    this.closureHooks.register(this.closureHook);
  }
}
