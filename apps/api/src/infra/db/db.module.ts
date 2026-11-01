import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { connect, type DbConnection } from "./client.js";

/** Token de injeção do banco (`Database`): `@Inject(DB) db: Database`. */
export const DB = Symbol("DB");
const DB_CONNECTION = Symbol("DB_CONNECTION");

/**
 * Banco: o conjunto de conexões pelo `DATABASE_URL`. Global, como o relógio. O pool
 * só conecta na primeira consulta, então a aplicação sobe sem banco (os testes da
 * F1 dependem disso).
 */
@Global()
@Module({
  providers: [
    { provide: DB_CONNECTION, useFactory: () => connect(process.env.DATABASE_URL ?? "") },
    { provide: DB, useFactory: (c: DbConnection) => c.db, inject: [DB_CONNECTION] },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_CONNECTION) private readonly connection: DbConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
