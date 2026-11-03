import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module.js";

/** Corpo de requisição de no máximo 64 KB (Arquitetura da Fase 1, Segurança). */
export const BODY_LIMIT = 64 * 1024;

/** O servidor HTTP (Fastify) com o limite do corpo. */
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({ bodyLimit: BODY_LIMIT });
}

/** Ajustes de uma aplicação já criada; createApp e os testes que montam o módulo na mão usam o mesmo. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  // Cabeçalhos de segurança (helmet). A API só responde JSON, então o padrão serve.
  await app.register(helmet);
  // O tempo real usa o `ws` puro (e não o socket.io): /ws no mesmo servidor da API.
  app.useWebSocketAdapter(new WsAdapter(app));
  // A API libera o CORS só para o endereço do site (WEB_ORIGIN).
  const origin = process.env.WEB_ORIGIN;
  if (origin) app.enableCors({ origin });
}

/** Monta a aplicação sem abrir porta; main.ts e os testes usam a mesma. */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter());
  await configureApp(app);
  return app;
}
