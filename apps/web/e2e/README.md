# Testes no navegador (Playwright)

As jornadas do site no Chromium, contra a API de verdade, um banco próprio e o relógio do jogo sob controle do teste. Nenhuma
tela da F7 à F15 foi vista por uma pessoa quando estas jornadas nasceram: elas são a primeira verificação automática delas
(e acharam dois defeitos reais, veja "O que as jornadas acharam").

## Como roda
```bash
export TEST_DATABASE_URL=postgres://postgres:<senha>@localhost:5432/postgres   # Postgres local; o Docker pode ficar desligado
npx playwright install chromium        # uma vez (uns 300 MB; PLAYWRIGHT_BROWSERS_PATH pode apontar para outro disco)
npm run e2e -w @futbolsa/web           # constrói o site de teste (out-e2e/) e roda tudo
npm run e2e:testar -w @futbolsa/web -- jornada-3   # só um arquivo, sem reconstruir o site
```

- **Um trabalhador só** e só o Chromium: com 8 GB de memória, dois contextos do navegador, a API e o Postgres cabem sem outro
  programa pesado aberto. Tudo leva uns 8 minutos (as jornadas que avançam o relógio pelas tarefas reais, como o fechamento de
  um mês, são as lentas).
- No CI roda em todo PR (job `e2e` do `ci.yml`). Vídeo, rastro e captura só nas falhas (`playwright-report/`, `test-results/`).

## O que sobe
O `webServer` do Playwright roda `npm run e2e:servidor -w @futbolsa/api` (`apps/api/ensaio/navegador.ts`): a API inteira
(porta 3100), o site de teste estático (3101, o `WEB_ORIGIN` da API: o CORS e o WebSocket são os de produção) e uma **porta de
controle** só em `127.0.0.1:3102` (`POST /cenario/mundo`, `/cenario/jogador`, `/cenario/avancar-ate`, `/derrubar`, `/subir`).
O banco é o `futbolsa_e2e`, recriado a cada subida. Cada jornada começa com `prepararCenario(...)`, que apaga tudo e recarrega a
temporada de 2025 pelas rotas do admin (uns 10 s).

- **Relógio:** a API usa um relógio fixo que só anda quando o teste manda (`avancarRelogio`), rodando as tarefas na ordem de
  produção. O relógio do navegador acompanha (`sincronizar`): o site decide pelo `Date.now()` do navegador se o IPO aceita
  ofertas.
- **Login:** o build de teste (`NEXT_PUBLIC_AUTH_CLIENT=fake`) troca o adaptador de login por um falso que lê o token do
  `localStorage` (`entrarComo(page, "ana")`). O build normal **não contém** esse adaptador: `guarda-build.spec.ts` procura a marca
  `FUTBOLSA_E2E_LOGIN_FALSO` em `out/` (build normal) e em `out-e2e/`. Nada disso existe em `src/` da API: o servidor de teste
  troca o verificador de token pelo módulo de testes do Nest, e um teste (`apps/api/test/ensaio/guardas.test.ts`) falha se a
  API de verdade importar a pasta de teste.

## As jornadas (prefixo `e2e <especificação> N` no nome do teste, para a auditoria de cobertura)
| Arquivo | Jornada |
|---|---|
| `jornada-1-conta` | convite, cadastro, apelido repetido/malformado/reservado, senha errada, privacidade do e-mail |
| `jornada-2-ipo` | ofertar, teto, piso, caixa, editar, cancelar, sigilo, fechamento e resultado |
| `jornada-3-mercado` | faixa de preço, boleta, compra a mercado, ordem no livro e cancelamento, 50 ordens, ordem contra si mesma, livro ao vivo com dois jogadores, "em jogo agora" |
| `jornada-4-carteira` | posição, reservas, patrimônio, carteira ao vivo, gráfico em linha e candles, sem escudo oficial |
| `jornada-5-rankings` | parcial do mês, mês fechado, conta excluída |
| `jornada-6-entrada` | quem chega depois do IPO: índice ou só caixa, e a escolha não se desfaz |
| `jornada-7-admin` | jogador comum barrado, pendências, suspensão de clube, bloqueio de jogador |
| `jornada-8-conta` | trocar apelido, excluir a conta |
| `jornada-9-celular` | 390 px sem rolagem horizontal, boleta na folha |
| `jornada-10-queda` | a API cai e volta com o livro aberto |
| `supabase/` | **à mão, nunca no CI:** `npm run e2e:supabase` (veja `supabase/README.md`) |

## O que fica de fora (e onde está)
- Fluxos que dependem de rodadas fechadas e de negócios suspeitos (pagamentos, correção com estorno, alerta de trapaça entre
  contas): são do **ensaio** (`apps/api/ensaio/`). O navegador só confere que as telas do admin abrem sem erro.
- Leilão, empate de ranking com bot e candles com dias de preço: dependem de muito histórico; ficam no ensaio e nos testes de
  tela com dados falsos.
- Sem imagem de referência: a conferência é por texto, estrutura e rolagem, nunca por pixels.

## O que as jornadas acharam (F16)
1. **CORS da API só liberava GET, HEAD e POST:** no navegador, o preflight de PUT (oferta do IPO), PATCH e DELETE (cancelar
   oferta ou ordem) falhava ("Failed to fetch"). Corrigido em `apps/api/src/app.ts` com teste do preflight.
2. **A tela do clube não desenhava o gráfico:** o `ClubView` recebia o gráfico por propriedade e nunca o renderizava. Corrigido.
3. Anotados em [[Problemas conhecidos]] (a F16 acha, não conserta): o painel de dividendos por clube (Livro 38) não aparece na
   tela do clube; o gráfico não aparece na tela do clube do celular; o administrador de teste entra no ranking com 0,00%.
