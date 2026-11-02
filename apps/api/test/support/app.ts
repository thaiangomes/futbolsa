import type { ModuleMetadata } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../../src/app.module.js";
import { configureApp, createAdapter } from "../../src/app.js";
import { Clock, FixedClock } from "../../src/infra/clock/index.js";
import { DB, type Database } from "../../src/infra/db/index.js";

export interface TestAppOptions {
  /** Banco do arquivo de teste (`useTestDatabase`); sem ele, a aplicação não consulta o banco. */
  db?: Database;
  /** Relógio fixo; o padrão começa em 2027-04-01 13:00 UTC. */
  clock?: FixedClock;
  /** Módulos e controllers só de teste, montados junto com a aplicação inteira. */
  imports?: ModuleMetadata["imports"];
  controllers?: ModuleMetadata["controllers"];
  /** Trocas de provedores além do relógio e do banco. */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** Recebe cada rota registrada (método e caminho), antes de a aplicação subir. */
  onRoute?: (method: string, url: string) => void;
}

/**
 * A aplicação inteira para os testes, montada como em produção (`createAdapter` e
 * `configureApp`), com o relógio fixo e o banco do arquivo de teste no lugar dos reais.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestFastifyApplication> {
  // As tarefas agendadas não rodam nos testes: eles chamam os serviços direto, com o relógio fixo.
  process.env.JOBS_ENABLED = "false";
  const clock = options.clock ?? new FixedClock(new Date("2027-04-01T13:00:00Z"));
  let builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(Clock)
    .useValue(clock);
  if (options.db) builder = builder.overrideProvider(DB).useValue(options.db);
  if (options.override) builder = options.override(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), { logger: false });
  if (options.onRoute) {
    const onRoute = options.onRoute;
    app.getHttpAdapter().getInstance().addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) onRoute(method, route.url);
    });
  }
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
