# FutBolsa

E se os clubes de futebol fossem empresas com ações na bolsa? No FutBolsa cada
clube brasileiro é uma ação com ticker próprio (FLA3, PAL3, COR3…). O jogador
começa com R$ 100 mil fictícios, entra nos IPOs, compra e vende num livro de
ofertas e recebe dividendos quando o clube pontua ou avança em copas. O preço é
formado pelos próprios jogadores; os dividendos dos resultados reais são a âncora.

Plano completo: https://claude.ai/artifact/2zXaWiDMEYT8T3jjR7bWaw

Moeda só fictícia, sem dinheiro real, e sem escudos ou marcas oficiais dos clubes.

## Fase 0: motor e simulação

Esta fase não tem interface. Ela traz o motor do mercado em TypeScript e uma
simulação da temporada 2025 com bots para calibrar IPO, dividendos e spread.

| Módulo | O que faz |
|---|---|
| `src/engine/bookbuilding.ts` | IPO por leilão de preço único. Centro da faixa = preço pela colocação do ano anterior (1º R$ 50, 2º 45, 3º 40, 4º 35, depois −R$ 2 por posição até R$ 3 no 20º), faixa de ±40%. Preço justo = maior preço em que a demanda acumulada cobre a oferta; rateio proporcional na quantidade; sobra para a tesouraria. |
| `src/engine/orderbook.ts` | Livro de ofertas com ordens a mercado e limitadas, prioridade preço-tempo, preço mínimo de R$ 0,50. Reserva dinheiro e ações das ordens abertas, então saldo e posição nunca ficam negativos. |
| `src/engine/ledger.ts` | Saldos e posições de cada conta, com reservas. |
| `src/engine/marketMaker.ts` | Formador de mercado da casa: compra e vende perto do último preço (spread de 2%, quantidade limitada) com o caixa e as ações da tesouraria; durante os jogos do clube amplia o spread para 6% e reduz a quantidade. |
| `src/engine/dividends.ts` | R$ 0,10 por ponto por ação no fechamento de cada rodada (Série B paga metade); jogo adiado paga no fechamento da rodada em que for disputado; colocação final de R$ 5,00 (1º) a zero (17º a 20º) no fechamento da última rodada; fases de copa quando terminam todos os jogos da fase; título de copa no apito final. |
| `src/sim/` | Simulação com bots de quatro perfis: dividendos, momentum, torcedor e aleatório. Cada um começa com R$ 100 mil, e cada clube emite 150 ações por jogador. |
| `src/data/`, `scripts/` | Formato dos dados de partidas, conversor do openfootball e coletor da football-data.org. Veja [data/README.md](data/README.md). |

Todo valor em dinheiro é um inteiro em centavos.

## Como rodar

Requer Node 20 ou mais novo.

```bash
npm install
npm test            # testes unitários (vitest)
npm run typecheck   # checagem de tipos
npm run sim         # simula a temporada 2025 e grava sim-output/
```

Opções da simulação:

```bash
npm run sim -- --seed 7 --bots 25 --ponto 30 --ancora peer
```

- `--seed`: semente (a simulação é reproduzível).
- `--bots`: bots por perfil (padrão 25, ou seja, 100 jogadores).
- `--ponto`: dividendo por ponto em centavos (padrão 10 = R$ 0,10). O dividendo da colocação final acompanha a mesma escala.
- `--ancora`: preço em volta do qual o formador de mercado cota: `lastTrade` (padrão, último negócio inclusive com a casa) ou `peer` (só negócios entre jogadores).

O resumo sai no terminal e em `sim-output/resumo-*.md`; os dados completos, com
o preço diário de cada clube, em `sim-output/resultado-*.json`.

Para atualizar os resultados pela API football-data.org, crie uma chave grátis e
rode `FOOTBALL_DATA_KEY=sua-chave npm run data:fetch -- 2025`. A chave fica só na
variável de ambiente (veja `.env.example`).

## O que a simulação de 2025 mostrou

Semente 2025, 100 bots, valores do plano. Resumo completo em `npm run sim`.

1. **O IPO fica abaixo do esperado.** Com 150 ações por jogador, 11 dos 20 clubes
   saíram no piso da faixa e sobrou ação para a tesouraria; os outros 9, os mais
   baratos, tiveram rateio. A demanda dos bots não cobre a oferta nos preços
   sugeridos.
2. **Os dividendos do plano são pequenos frente aos preços.** Na temporada
   inteira, uma ação pagou de R$ 1,70 (Sport) a R$ 12,90 (Flamengo). No IPO a soma
   dos preços era 2,2 vezes a soma dos dividendos da temporada. Os bots de
   dividendos ficaram quase só em caixa (+2%).
3. **A autocorreção pelos dividendos não apareceu.** A correlação entre preço e
   dividendos que ainda viriam ficou entre 0,3 e 0,5 o ano todo, sem subir, e os
   preços subiram de 1,2 a 7,5 vezes entre o IPO e o fim. Com cerca de 65% do caixa sobrando depois do IPO e nada que ancore o
   valor da ação no fim da temporada, quem define o nível de preço é a quantidade
   de dinheiro, e não os dividendos. Com R$ 0,30 por ponto o IPO fica perto do
   valor justo (0,8×), mas a deriva de alta continua.
4. **Preço só pelos negócios entre pessoas cria viés de alta.** Quando a
   tesouraria fica sem ações, o formador de mercado só compra: as vendas batem
   nele sem mexer no preço, e as compras batem em outros jogadores e mexem. Por
   isso o padrão agora conta também os negócios com a casa
   (`houseTradesSetPrice`) e o formador cota em volta do último negócio.

Ideias para a próxima rodada de calibração: um valor de resgate da ação no fim
da temporada (por exemplo, a casa recompra pelo dividendo da colocação), venda a
descoberto ou aluguel de ações, menos caixa livre (IPO maior ou mais ações por
jogador) e dividendo por ponto de R$ 0,30 a R$ 0,50.
