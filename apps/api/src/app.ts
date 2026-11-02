import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module.js";

/** Ajustes de uma aplicação já criada; createApp e os testes que montam o módulo na mão usam o mesmo. */
export function configureApp(app: NestFastifyApplication): void {
  // O tempo real usa o `ws` puro (e não o socket.io): /ws no mesmo servidor da API.
  app.useWebSocketAdapter(new WsAdapter(app));
  // A API libera o CORS só para o endereço do site (WEB_ORIGIN).
  const origin = process.env.WEB_ORIGIN;
  if (origin) app.enableCors({ origin });
}

/** Monta a aplicação sem abrir porta; main.ts e os testes usam a mesma. */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  configureApp(app);
  return app;
}
