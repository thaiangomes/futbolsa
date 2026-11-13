import { Module } from "@nestjs/common";
import { AdminLogModule } from "../log/index.js";

/**
 * Trapaça entre contas no admin (F14, parte 2, T20 a T27): alerta, relatório, decisão e banimento. A pasta cresce
 * tarefa a tarefa; os serviços e controladores entram aqui conforme ficam prontos.
 */
@Module({ imports: [AdminLogModule] })
export class FraudModule {}
