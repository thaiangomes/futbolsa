import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { ClockModule } from "./infra/clock/index.js";
import { DbModule } from "./infra/db/index.js";
import { HttpInfraModule } from "./infra/http/index.js";
import { AuthAdapterModule } from "./infra/auth-adapter/index.js";
import { RealtimeModule } from "./infra/realtime/index.js";
import { JobsModule } from "./infra/jobs/index.js";
import { AccountsModule } from "./modules/accounts/index.js";
import { IpoModule } from "./modules/ipo/index.js";
import { MarketModule } from "./modules/market/index.js";
import { DividendsModule } from "./modules/dividends/index.js";
import { EntryModule } from "./modules/entry/index.js";
import { PortfolioModule } from "./modules/portfolio/index.js";
import { RankingsModule } from "./modules/rankings/index.js";
import { AdminModule } from "./modules/admin/index.js";

@Module({
  imports: [
    // infraestrutura
    ClockModule,
    DbModule,
    HttpInfraModule,
    AuthAdapterModule,
    RealtimeModule,
    JobsModule,
    // módulos de negócio, um por nota dona
    AccountsModule,
    IpoModule,
    MarketModule,
    DividendsModule,
    EntryModule,
    PortfolioModule,
    RankingsModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
