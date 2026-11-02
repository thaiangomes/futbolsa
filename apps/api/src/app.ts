import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { toErrorResponse } from "./infra/http/index.js";

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
  // Erros do próprio Fastify, antes de chegar a uma rota (corpo grande demais, JSON
  // malformado), saem no mesmo formato `{ code, message }` dos outros.
  app.getHttpAdapter().getInstance().setErrorHandler((error, _request, reply) => {
    const { status, body } = toErrorResponse(error);
    void reply.status(status).send(body);
  });
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
