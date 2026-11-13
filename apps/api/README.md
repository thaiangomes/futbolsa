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

## Admin (F7)

Módulo `src/modules/admin/`, uma subpasta por assunto, cada uma com o próprio módulo do Nest:

| Pasta | O que faz | Rotas |
|---|---|---|
| `log/` | Registro do admin: `AdminLogService.record(tx, ação)` na transação da ação, `reasons.ts` com as ações que exigem motivo, `listLog` | `GET /admin/log` |
| `results/` | Fontes (ESPN e football-data.org), importação sem pisar no jogo do admin, jogos, pendências, tarefas agendadas | `GET/POST/PATCH /admin/matches`, `GET /admin/pending`, `POST /admin/imports/run` |
| `standings/` | Classificação oficial da Série A e da B | `GET /admin/standings`, `PATCH /admin/standings/:competição`, `POST .../confirm` |
| `seasons/` | Preparar a temporada, valores das ligas e tabela das copas | `GET /season` (público), `GET /admin/clubs`, `GET /admin/seasons/current`, `POST/PATCH /admin/seasons`, `PUT .../clubs`, `GET/PUT .../rules`, `PUT .../cups/:copa`, `POST .../confirm` |
| `suspension/` | Suspender e retomar um clube ou o mercado | `GET/POST/DELETE /admin/suspensions` |
| (raiz) | Visão geral e eventos de tempo real | `GET /admin/overview`; `market.suspended`, `market.resumed` e `admin.pending` |

- **Todo motivo vai ao registro.** Cada ação grava autor, hora, antes, depois e motivo na mesma transação.
  Ação nova entra em `ADMIN_ACTIONS` (`log/reasons.ts`) dizendo se o motivo é obrigatório; o `record` recusa nome
  desconhecido e e-mail no antes ou no depois.
- **Jogo editado à mão vale mais que a fonte** (`matches.manual_override`): a importação só atualiza o
  `source_snapshot`, e a tela mostra a divergência.
- **Fontes:** a ESPN atende todas as competições por padrão. `RESULT_SOURCES=brasileirao-a=football-data` usa a
  football-data.org onde o plano da `FOOTBALL_DATA_KEY` a cobre. Os testes nunca chamam as fontes: usam as respostas
  guardadas em `test/admin/fixtures/`.
- **Tarefas agendadas** (`results/jobs.ts`): calendário a cada hora quando a última importação passou de 24 horas,
  placares a cada 15 minutos das competições com jogo devido e a classificação depois deles. `JOBS_ENABLED=false` desliga.
- **Ganchos para as outras fases:** `MarketPort` (a F9 troca a implementação vazia), `MatchesEvents` (a F12 assina),
  `SeasonValuesService` em `modules/dividends/season-values` (`assertCupsConfirmed`, `lockSeasonValues` e
  `loadSeasonValues`, para a F8, a F9 e a F12).
- **Nos testes:** `expectAdminOnly(app, db, rota)` (`test/support/admin-routes.ts`) confere 401, 403 e o acesso do admin.

### Jogadores, auditoria e bots (F14, parte 1)

| Pasta | O que faz | Rotas |
|---|---|---|
| `players/` | Ver jogadores (busca por prefixo do apelido ou e-mail exato), bloquear e desbloquear, excluir, ajustar saldo | `GET /admin/players`, `GET /admin/players/:id`, `GET .../entries`, `POST .../block`, `POST .../unblock`, `DELETE /admin/players/:id`, `POST .../adjust` |
| `audit/` | Negócios com comprador e vendedor (a consulta é do `market`, `market/audit/audit-trades.ts`) | `GET /admin/trades` |
| `bots/` | Ligar e desligar bots por perfil, a visão de mercado dos bots e a tarefa que os faz agir | `GET/PATCH /admin/bots` |
| `seasons/` | A chave "bots nos rankings" | `PATCH /admin/seasons/:id` com `{ botsInRankings }` (sozinho) |

- **Bloquear** cancela as ordens abertas (`blocked`) e a oferta do IPO (só com o IPO aberto) pelos ganchos do `accounts`;
  o bloqueado continua dono das ações, recebe dividendos e lê a carteira. **Excluir** usa o `deleteAccount` da F5, que
  ganhou dois ganchos (`validate` e `record`) para o admin conferir o apelido e gravar o registro na mesma transação.
- **Ajustar saldo** exige `Idempotency-Key`. Regra pura em `players/adjust.rules.ts`: crédito de ações sai das ações
  livres da tesouraria pelo **preço exibido**; débito só do que está livre; caixa de `ipo_open` a `trading_ended`, ações só em
  `trading`. O caixa não passa pela tesouraria.
- **Bots:** o admin define quantos ficam ativos por perfil (0 a 200). Desliga os de id maior; liga religando os de id menor
  antes de criar novos. Com o IPO aberto o bot ganha R$ 100.000,00; depois do IPO, pela carteira índice da F11; depois da
  janela, `bot_entry_closed`. A tarefa `bots-run` (`bots/runner.ts`) roda a cada `BOT_TICK_MINUTES` (padrão 15) e cada bot age com
  chance `BOT_ACTIVITY × BOT_TICK_MINUTES ÷ 180` (padrão 0,25: ≈ 2,1% por rodada, o mesmo ritmo da simulação calibrada,
  decidindo em média a cada 12 horas). Os bots passam pelo `placeOrder` da F9, com a porta `bot_inactive` conferida com a carteira
  travada; `JOBS_ENABLED=false` desliga a tarefa.
- **Visão dos bots:** `BotView` (motor, `src/sim/botView.ts`) é o que os perfis leem e fazem; a simulação usa `MarketView` e a
  API usa `LiveBotView` (`bots/live-view.ts`), as duas sobre o `LeagueView` do motor, então o valor justo e a colocação são as
  mesmas contas. O estado de cada bot fica na memória, com a semente de (temporada, id do bot).
- **Migração `0004_admin_jogadores`:** índices de `trades` por carteira (a auditoria por jogador), `trade_annulled` em
  `wallet_entries.kind`, `annulment` em `orders.cancel_reason` e as tabelas da trapaça entre contas (`fraud_cases`,
  `fraud_case_trades`, `trade_annulments`, `fraud_warnings`, `player_notices`), que a parte 2 da F14 usa.

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
