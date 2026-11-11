# Mercado secundário (`market`)

Dono: módulo `market` (livro de ofertas, formador de mercado da casa, túnel de preço e leilão, abertura e fim da negociação).
O desenho e as regras estão no vault, em `Técnica/Planos/Plano do livro de ofertas e formador.md` e em
`Funcionalidades/Livro de ofertas e formador de mercado.md` (critérios 1 a 45). As regras puras ficam no motor
(`packages/engine`: `matchOrder`, `validateOrder`, `settlement`, `computeQuote`, `fairValue`, `tunnelBand`, `clearAuction`);
aqui ficam o banco, as travas, as rotas, as tarefas e os eventos.

## Arquivos
| Pasta e arquivo | O que faz |
|---|---|
| `matching/postgres-matching-engine.ts`, `matching-engine.ts` | O motor de ordens: a ordem nova passo a passo (trava do clube, porta do horário, `validateOrder`, casamento, trava das contrapartes possíveis pelo preço, releitura, segundo casamento, túnel, gravação). `MatchingEngine` é a porta. |
| `matching/settle.ts` | Liquida um negócio: `trades`, as duas linhas `trade` do extrato e o andamento das ordens do livro. Serve à ordem nova e ao fim do leilão. |
| `orders/` | `OrderService` (a entrada de jogador, bot e casa), `PlayerOrdersService` e `OrdersController` (`POST`, `GET` e `DELETE /orders`, com `Idempotency-Key`), `CancelService` (`cancelOrder`, `cancelOrders`), `MarketClosureHook` (o gancho de bloqueio e exclusão de conta). |
| `auction/close-auction.ts` | `closeAuction`: o preço único do fim do leilão. A tarefa `auction-close` (`infra/jobs/market-jobs.ts`) roda a cada 5 segundos. |
| `state/` | `displayedPrice` (agora e no passado), `tradingGate` (horário e suspensão), modo de jogo, o estado do túnel e do leilão. |
| `book/` | O livro de 5 níveis e os 20 últimos negócios (`GET /clubs/:ticker/book`, `GET /clubs`). |
| `maker/` | O formador: valor justo pelo banco, a cotação, `refreshClub`, a agenda (`RefreshJob`, a cada minuto) e o `RefreshWaker`. |
| `opening/opening.job.ts` | A abertura às 10h de Brasília do dia seguinte ao fechamento do IPO, com a liquidação feita. |
| `ending/end-trading.ts` | `endTrading(tx, instante)`: o fim da negociação, para a F15 chamar quando a recompra fecha. |
| `ports/market-port.ts` | O `MarketPort` de verdade da F7: suspensão (cancela a casa, para o leilão) e pedido de reposição. |
| `realtime/` | `trade`, `candle`, `book`, `price`, `order.updated`, `wallet.changed`, `match_mode` e `season.status` depois do `COMMIT`; o `BookPublisher` (P3). |
| `admin/` | `PATCH /admin/market-maker`: os percentuais da casa. |

## Regras que valem para quem mexer aqui
- **Ordem das travas** (a do jogo todo): temporada → clubes por ticker → eventos de pagamento → carteiras por id → tesouraria por último. A transação de uma ordem trava o clube primeiro, lê a temporada **depois** (sem trava) e só então as carteiras. O `LockState` do `Tx` acusa `LockOrderError`.
- **Dinheiro** em centavos inteiros e extrato só pelo `portfolio.post`. Ordem recusada não grava nada.
- **Eventos** só em `tx.afterCommit`. Evento público nunca leva dono nem contraparte.
- **Túnel e leilão:** a ordem que executaria fora do túnel (10% em volta da referência) não executa nada e abre o leilão de 3 horas; a ordem a mercado nunca abre leilão (executa só dentro do túnel e o resto é cancelado). Quem acha um leilão vencido o fecha antes (`AuctionCloser`) e repete.
- **Leilão e suspensão:** a suspensão para a contagem do leilão (`auction_until` nulo) e a retomada recomeça as 3 horas, se não sobra suspensão do clube nem do mercado.
- **Fim da negociação:** `endTrading` trava a temporada, todos os clubes, as carteiras com ordens abertas e a tesouraria; cancela tudo com `trading_end`. Custa uns 8 ms por ordem aberta numa transação só (medido); as leituras do livro filtram só por clube porque o `endTrading` cancela tudo no fim da temporada.
- **Tempo:** com a trava do clube uma ordem leva ~27 ms; o fim de um leilão com 2.000 ordens levou ~27 s (quase tudo no extrato, `portfolio.post` um a um). `apps/api/scripts/market-lock-timing.mjs` mede.

## Testes
`apps/api/test/market/`: um arquivo por tarefa do plano, com os números da especificação nos nomes (`livro 40: ...`). Os testes de concorrência usam barreira e 50 repetições, alternando quem sai primeiro, e conferem que nenhuma transação repetiu por deadlock. `stress.test.ts` sorteia ordens, cancelamentos, reposições, leilões e suspensões ao mesmo tempo e confere as invariantes (`test/support/invariants.ts`).
