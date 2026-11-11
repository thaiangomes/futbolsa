import { Module, type OnModuleInit } from "@nestjs/common";
import { AccountClosureHooks } from "../accounts/index.js";
import { AdminLogModule } from "../admin/log/index.js";
import { MarketPort } from "../admin/results/ports.js";
import { DividendsModule } from "../dividends/dividends.module.js";
import { RealtimeModule } from "../../infra/realtime/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { MarketMakerAdminController } from "./admin/market-maker.controller.js";
import { MarketMakerAdminService } from "./admin/market-maker.service.js";
import { CloseAuctionAdapter, CloseAuctionService } from "./auction/close-auction.js";
import { BookController } from "./book/book.controller.js";
import { BookReadService } from "./book/book-read.service.js";
import { FairValueService } from "./maker/fair-value.service.js";
import { RefreshJob } from "./maker/refresh.job.js";
import { OpeningJob } from "./opening/opening.job.js";
import { RefreshService, RefreshWaker } from "./maker/refresh.service.js";
import { MatchingEngine } from "./matching/matching-engine.js";
import { PostgresMatchingEngine } from "./matching/postgres-matching-engine.js";
import { CancelService } from "./orders/cancel.service.js";
import { MarketClosureHook } from "./orders/closure-hook.js";
import { OrderService } from "./orders/order.service.js";
import { OrdersController } from "./orders/orders.controller.js";
import { PlayerOrdersService } from "./orders/player-orders.service.js";
import { EndTradingService } from "./ending/end-trading.js";
import { MarketPortImpl } from "./ports/market-port.js";
import { BookPublisher } from "./realtime/book-publisher.js";
import { MarketEvents } from "./realtime/events.js";
import { AuctionCloser } from "./state/tunnel-state.js";

/**
 * Mercado secundário (F9: livro de ofertas e formador de mercado): a porta `MatchingEngine` ligada à implementação do
 * Postgres e o `OrderService`, a entrada das ordens de jogadores, bots e da casa; o cancelamento (`CancelService`); as
 * rotas das ordens do jogador (`POST`, `GET` e `DELETE /orders`), do livro e do formador; e os eventos.
 *
 * Na subida, registra no `accounts` o gancho de encerramento das ordens (`MarketClosureHook`), que a exclusão (F5) e
 * o bloqueio (F14) chamam. O `accounts` (global) não importa este módulo: a dependência fica num sentido só.
 *
 * Túnel de preço: a ordem que sairia do túnel abre o leilão (L4), e o `CloseAuctionService` o fecha (L5). Quem
 * encontra o leilão vencido (o `OrderService`, o `PlayerOrdersService` e o `CancelService`) recebe o `AuctionCloser`
 * (`state/tunnel-state.ts`), ligado aqui ao fim do leilão de verdade (P10); a tarefa `auction-close`
 * (`infra/jobs/market-jobs.ts`) fecha os outros a cada 5 segundos.
 *
 * Formador de mercado: o `RefreshService` repõe a cotação da casa num clube (T10 e L6), com o valor justo do
 * `FairValueService` (T9), e grava os pedidos de reposição (`requestRefresh`). Depois do COMMIT do pedido, ele chama o
 * `RefreshWaker`, em que a agenda (T11) se inscreve para repor na hora; sem inscrito, o pedido espera a tarefa de cada
 * minuto.
 *
 * Suspensão e fim da negociação: a porta `MarketPort` da F7 (T13 e L7) é provida e exportada aqui
 * (`ports/market-port.ts`); o `ResultsModule` do admin importa este módulo e o reexporta para a suspensão, a
 * importação e os pagamentos. Este módulo não importa módulos do admin além do `AdminLogModule` (só arquivos), e a
 * dependência fica num sentido só. O `EndTradingService` (T14) é o fim da negociação que a F15 chama na transação dela.
 */
@Module({
  imports: [PortfolioModule, AdminLogModule, RealtimeModule, DividendsModule],
  controllers: [MarketMakerAdminController, BookController, OrdersController],
  providers: [
    { provide: MatchingEngine, useClass: PostgresMatchingEngine },
    CloseAuctionService,
    { provide: AuctionCloser, useClass: CloseAuctionAdapter },
    OrderService,
    CancelService,
    PlayerOrdersService,
    MarketClosureHook,
    MarketMakerAdminService,
    BookReadService,
    BookPublisher,
    MarketEvents,
    FairValueService,
    RefreshService,
    RefreshJob,
    OpeningJob,
    RefreshWaker,
    { provide: MarketPort, useClass: MarketPortImpl },
    EndTradingService,
  ],
  exports: [
    OrderService,
    CancelService,
    MarketEvents,
    BookPublisher,
    CloseAuctionService,
    AuctionCloser,
    FairValueService,
    RefreshService,
    RefreshJob,
    OpeningJob,
    RefreshWaker,
    MarketPort,
    EndTradingService,
  ],
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
