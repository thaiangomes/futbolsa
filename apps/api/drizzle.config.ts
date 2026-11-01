import { defineConfig } from "drizzle-kit";

// `npm run db:generate` gera a migração SQL a partir do esquema em TypeScript.
// Migração nova depois da inicial: uma fase de cada vez (Arquitetura da Fase 1, Migrações).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infra/db/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["futbolsa"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
