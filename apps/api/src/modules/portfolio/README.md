# Carteira e gráficos (F10)

Módulo `portfolio`. Escrita em carteiras só pelo `PortfolioLedger` (F4, `ledger/`); o que a F10 traz é **leitura**: carteira, extrato,
gráficos, patrimônio diário e foto mensal. Dinheiro em centavos inteiros; dias e meses contados em Brasília pelo motor.

## Rotas

| Rota | Quem | O que devolve |
|---|---|---|
| `GET /portfolio` | jogador (bloqueado também) | caixa total, reservado e livre, a receber, posições (preço médio, custo, valor a mercado, não realizado, dividendos, fatia, `auction`), resultado por clube, patrimônio e rentabilidade, `seq` do canal `me` |
| `GET /portfolio/entries?club=&kind=&before=&limit=` | jogador | extrato por cursor (horário, id), do mais novo ao mais antigo; **nunca** a contraparte; as linhas só de reserva ficam de fora |
| `GET /portfolio/equity` | jogador | ponto de entrada (R$ 100.000,00), um ponto por dia fechado, valor atual e os dias com dividendo |
| `GET /portfolio/clubs/:ticker/trades?range=` | jogador | meus negócios no clube e o meu preço médio |
| `GET /clubs/:ticker/candles?range=` | público | candles (15 minutos em `today`, diários nos demais) com os períodos sem negócio repetindo o fechamento |
| `GET /clubs/:ticker/markers?range=` | público | jogos e dividendos (com "aguardando aprovação" e estornos) |
| `GET /players/:nickname` | público | o apelido e `snapshot`, a foto mensal em décimos de ponto percentual (ou `null`) |

`range` é `today`, `7d`, `30d` ou `season`.

## Valor da carteira num instante (`valuation/`)

`EquityAt.forSeason(tx, seasonId, T, { wallets? })` é a **única** conta do patrimônio (carteira, ponto diário, foto mensal e,
na F13, os rankings). Roda dentro do `tx` de quem chama (não abre transação nem conexão, não trava nada), só com `SELECT`, e o
número de consultas não depende do número de carteiras. Caixa e ações de T = estado de hoje menos os movimentos depois de T
(a linha `season_close` conta sempre como "depois"); preço de T = `market.displayedPrices`; a receber de T = ações da foto do
evento vigente × valor por ação − créditos de todas as versões da mesma chave até T; a recompra fechada
(`trading_ended_at ≤ T`) zera o valor das ações.

## Tarefas (recuperação a cada 5 minutos, `infra/jobs/portfolio-jobs.ts`)

- `equity-daily` (`EquityDailyService.runOnce(agora)`): grava `equity_daily` dos dias fechados há mais de 30 segundos, do mais
  antigo ao mais novo, em lotes de 500 carteiras (jogadores e bots, nunca a tesouraria). Repetir não duplica. **A correção de
  pagamento não regrava dias passados.**
- `portfolio-snapshots` (`SnapshotService.runOnce(agora)`): grava as fatias dos meses fechados (`monthCloseAt`); `takeSnapshots(tx, …)`
  serve à F15 no encerramento. O perfil mostra o mês fechado mais novo anterior ao mês corrente.

Ambas pulam a temporada `closed` e desligam com `JOBS_ENABLED=false`.

## Dados de demonstração

`npm run demo:carteira -w @futbolsa/api` monta o jogador `anagol` dos Protótipos (patrimônio de R$ 117.210,00) num banco de
**desenvolvimento vazio** (veja o cabeçalho do script).
