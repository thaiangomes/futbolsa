import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";

/** Monta a aplicação sem abrir porta; main.ts e os testes usam a mesma. */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  // A API libera o CORS só para o endereço do site (WEB_ORIGIN).
  const origin = process.env.WEB_ORIGIN;
  if (origin) app.enableCors({ origin });
  return app;
}
