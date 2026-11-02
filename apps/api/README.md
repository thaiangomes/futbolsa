# API do FutBolsa

NestJS com Fastify. Os módulos ficam em `src/modules/<módulo>` (um por nota dona de regra) e a
infraestrutura em `src/infra/*`. O desenho está na nota `Técnica/Arquitetura da Fase 1.md` do vault.

Os comandos rodam da raiz do repositório.

## Banco

Postgres pelo Drizzle ORM. As tabelas ficam no esquema `futbolsa`, e não no `public`. O esquema
em TypeScript fica em `src/infra/db/schema/`, um arquivo por módulo dono, e as migrações em SQL
ficam em `drizzle/`.

```bash
npm run db:migrate               # aplica as migrações que faltam no DATABASE_URL (lido do .env)
npm run db:seed -- --year 2027   # os 20 clubes e a temporada em preparação; rodar de novo não muda nada
npm run db:generate              # gera a migração SQL depois de mudar o esquema em TypeScript
```

- O contêiner da API roda `node dist/infra/db/migrate.js` antes de subir; subir de novo não aplica nada.
- **Migração nova depois da inicial:** uma fase de cada vez, para não haver duas com o mesmo número.
  Revise o SQL gerado antes do commit. O que o Drizzle não gera (gatilhos) vai numa migração
  escrita à mão (`npx drizzle-kit generate --custom --name <nome>`, dentro de `apps/api`), como a
  `0001_restricoes.sql`.
- **Transações:** toda escrita em dinheiro ou ações passa por `withTransaction` e trava as linhas
  com `lockSeason`, `lockClubs` e `lockWallets` (`src/infra/db/`), sempre na ordem temporada,
  clubes por ticker, carteiras por id e a tesouraria por último. Uma trava fora dessa ordem dá
  `LockOrderError`.
- **Carteiras:** só o `portfolio.post` (`src/modules/portfolio/ledger/`) escreve em `wallets` e
  `positions`, e grava junto a linha do extrato.

## Testes

```bash
npm test                         # motor e API; a API roda contra um Postgres de verdade
```

Os testes da API criam um banco modelo migrado, com nome único por execução, e cada arquivo de
teste usa uma cópia própria, apagada no fim. O servidor vem de `TEST_DATABASE_URL`:

- **Postgres instalado na máquina:** aponte `TEST_DATABASE_URL` para ele, por exemplo
  `postgres://usuario:senha@localhost:5432`. Sem o nome do banco, entra no banco do usuário.
- **Docker:** `docker compose up -d postgres-test`. Sem `TEST_DATABASE_URL`, os testes usam esse
  (porta 5433).

Para verificar o dinheiro e as ações nos testes das fases seguintes, use
`assertLedgerConsistent` e `assertSharesConserved` de `test/support/invariants.ts`.

## Login e permissões

O login fica atrás de um adaptador (`src/infra/auth-adapter/`): a API só conhece a interface
`AuthVerifier`, e a implementação do Supabase confere o token pelas chaves públicas do projeto
(`SUPABASE_URL`). Sem `SUPABASE_URL`, todo token é recusado.

- **Toda rota pede login por padrão.** Rota sem login leva `@Public()` e entra na lista
  `PUBLIC_ROUTES` de `test/support/routes.ts` no mesmo commit; o teste de varredura
  (`test/auth/routes-scan.test.ts`) falha se uma rota nova responder sem login.
- **Rotas de admin:** todo controller de `/admin` leva `@AdminOnly()`. O papel e a situação são
  lidos do banco a cada chamada. A varredura também confere que um jogador comum recebe 403.
- **Quem chama:** `@CurrentUser()` devolve `{ id, role, status }`. O usuário bloqueado passa no
  login (lê a própria carteira); quem impede o bloqueado de negociar é o serviço, dentro da transação.
- **Erros:** lance `DomainError(code, status, mensagem)` (`src/infra/http/`); toda resposta de
  erro sai como `{ code, message }`. Valide a entrada com `new ZodValidationPipe(esquema)` do contrato.
- **Limites de uso:** `@RateLimit("signup" | "orders" | "bids")`; o resto fica no limite geral.
- **Nos testes:** `createTestApp({ db, clock, override: withTestAuth(clock) })` (`test/support/app.ts`
  e `auth.ts`), `createAccount(db, { role: "admin" })` (`test/support/accounts.ts`) para ter um
  jogador ou admin com token, e `bearer(token)` no `app.inject`.

## Conferir o login no Supabase

Depois de configurar o login no painel do projeto (Authentication), com o `.env` preenchido
(`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`):

```bash
npm run auth:check -w @futbolsa/api
```

Confere as chaves de assinatura assimétricas (a API recusa `HS256`), login por e-mail e pelo
Google ligados, confirmação de e-mail ligada e login anônimo desligado. Com
`SUPABASE_TEST_TOKEN=<token>` (de um usuário de teste que confirmou o e-mail), confere que o
token passa pelo verificador da API e traz `user_metadata.email_verified`. Com
`SUPABASE_CHECK_DELETE_SUBJECT=<id>`, apaga esse usuário pela API de administração.

No painel, à mão: senha mínima de 8 caracteres, endereços do site (Site URL e Redirect URLs),
um SMTP próprio para os e-mails chegarem aos jogadores e a troca de senha segura (Secure
password change) ligada.
