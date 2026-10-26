# FutBolsa: plano do jogo e handoff

Atualizado em 2026-10-26. Plano vivo (Claude Doc): https://claude.ai/artifact/2zXaWiDMEYT8T3jjR7bWaw
Repositório: https://github.com/thaiangomes/futbolsa

> **Para o Claude Code que for continuar:** leia este arquivo inteiro, depois rode `git status` e `git log --oneline --all` para conferir o estado. Continue a partir da seção 7, "Estado atual e próximos passos". Responda em português.

---

## 1. Visão

Jogo web em que cada clube de futebol brasileiro é uma empresa listada com ticker (FLA3, PAL3, COR3…). O jogador começa com R$ 100 mil fictícios, compra e vende ações, recebe dividendos pelas conquistas reais do clube e disputa rankings.

- **Objetivos:** entreter e ensinar a investir. Por isso o jogo copia mecanismos reais da B3: IPO por bookbuilding, livro de ofertas, formador de mercado, dividendos.
- **Público:** torcedores que acompanham o futebol brasileiro e gostam de fantasy (Cartola) ou de bolsa.
- **Loop:** cada ano é uma temporada. O jogador entra nos IPOs, negocia durante o ano (inclusive com a bola rolando), recebe dividendos e disputa os rankings mensal e anual.
- **Moeda:** só fictícia. Dinheiro real transformaria o jogo em aposta regulada (Lei 14.790/2023).

## 2. Decisões já tomadas pelo Thaian

| Tema | Decisão |
| --- | --- |
| Plataforma | Web |
| Clubes listados | 20 da Série A do ano **+** os 13 do Clube dos Treze mesmo se estiverem na Série B (Flamengo, Fluminense, Vasco, Botafogo, Corinthians, Palmeiras, São Paulo, Santos, Grêmio, Internacional, Cruzeiro, Atlético-MG, Bahia) |
| Formação de preço | Pelo mercado (jogadores negociando entre si), com dividendos como âncora que corrige exageros. A fórmula automática (Elo) foi descartada |
| Contraparte | Livro de ofertas entre jogadores **+ formador de mercado da casa** |
| Negociação durante os jogos | Livre o tempo todo, sem leilão nem trava por placar, sem API ao vivo |
| Dividendo por ponto | Só no fim da rodada, depois que o último jogo da rodada termina (evita trocar ativos jogo a jogo) |
| Fase de copa | Paga quando terminam todos os jogos daquela fase (no ida e volta, após o último jogo de volta) |
| Título de copa | Pago no apito final da decisão |
| Título e colocação do Brasileirão | Pagos no fechamento da última rodada |
| Fim da temporada | Todos voltam a R$ 100 mil; novos IPOs no ano seguinte |
| Bots | Usados para testar na Fase 0; podem continuar no jogo se houver poucos jogadores |
| Escudos | Não usar escudos oficiais (marcas registradas). Nomes só em texto, identidade própria (ticker + selo com cores/sigla) e aviso de não afiliação |

**Em aberto:** escopo do premium (fora do MVP). Entrada no meio da temporada tem proposta (seção 3.6), ainda sem confirmação.

## 3. Como o mercado funciona

### 3.1 Ciclo da temporada
1. **Bookbuilding** (~1 semana antes da 1ª rodada): cada clube abre oferta com faixa de preço; jogadores registram intenções de compra (quantidade e preço máximo).
2. **Precificação e estreia:** o jogo calcula o preço justo, aplica rateio se precisar; negociação começa no dia seguinte.
3. **Temporada:** negociação livre; dividendos por rodada e por fase.
4. **Fechamento:** última rodada, dividendo por colocação final, ranking anual. No ano seguinte todos voltam a R$ 100 mil.

### 3.2 Bookbuilding
- **Preço sugerido** pela colocação do ano anterior: 1º R$ 50, 2º R$ 45, 3º R$ 40, 4º R$ 35, depois −R$ 2 por posição até 20º R$ 3 (soma dos 20 = R$ 458).
- **Faixa:** preço sugerido ±40%. Os 4 recém-promovidos usam os preços do 17º ao 20º. Clubes do Clube dos Treze na Série B usam o preço do 20º (R$ 3).
- **Preço justo:** o maior preço em que a demanda acumulada cobre todas as ações ofertadas; todos pagam o mesmo preço.
- **Rateio:** demanda acima da oferta no preço máximo → cada um recebe a mesma fração do que pediu (na quantidade, não no preço).
- **Sobra:** se faltar demanda no preço mínimo, o que sobrar vai para a tesouraria do jogo.
- **Quantidade de ações:** ~150 ações por clube por jogador esperado (os IPOs absorvem ~70% do caixa). Ex.: 1.000 jogadores → ~150 mil ações por clube. Todos os clubes têm o mesmo número de ações.

### 3.3 Mercado secundário
- Ordens a mercado e limitadas, livro com prioridade preço-tempo, saldo e posição nunca negativos (sem venda a descoberto).
- **Formador de mercado da casa:** sempre cota compra e venda perto do último preço, spread ~2%, quantidade limitada, usando a tesouraria. Durante os jogos de um clube (horário do calendário), aumenta o spread e reduz a quantidade, porque não sabe o placar.
- Preço mínimo de R$ 0,50.

### 3.4 Bots
Perfis: **dividendos** (compra o que rende mais), **momentum** (segue a tendência), **torcedor** (só compra o próprio time), **aleatório** (gera volume). Usam a mesma API de ordens dos humanos, aparecem marcados como bot e ficam fora dos rankings e premiações. O número de bots cai conforme cresce o volume entre jogadores.

### 3.5 Dividendos (valores iniciais para calibrar, por ação)

| Evento | Dividendo | Quando paga |
| --- | --- | --- |
| Cada ponto no Brasileirão | R$ 0,10 (Série B: R$ 0,05) | Fim da rodada (após o último jogo). Jogo adiado paga na rodada em que for disputado |
| Avançar de fase na Copa do Brasil | R$ 0,50 a R$ 4,00, crescendo a cada fase | Quando terminam todos os jogos da fase |
| Avançar de fase na Libertadores | 1,5× o valor da Copa do Brasil | Idem |
| Título de copa | R$ 8,00 (Libertadores R$ 12,00) | Apito final da decisão |
| Colocação final no Brasileirão | De R$ 5,00 (1º) a zero (17º–20º) | Fechamento da última rodada |
| Acesso à Série A (Clube dos Treze na B) | Bônus a definir | Fechamento da temporada |

Recebe quem tiver a ação no momento do pagamento. Exemplo da autocorreção: só por pontos, líder com 75 pts comprado a R$ 50 rende 15%; lanterna com 25 pts comprado a R$ 3 rende 83%. Por isso a faixa do bookbuilding é larga.

### 3.6 Quem entra no meio da temporada (proposta, aguardando o Thaian)
- A cada novato, o jogo emite a mesma quantidade de ações de cada clube, valendo R$ 70 mil a preços atuais (~150 de cada no início). A relação dinheiro/ações fica igual à do IPO, então o preço não infla. Dividendo é por ação, então não dilui ninguém.
- **Padrão, carteira índice:** essas ações + R$ 30 mil em caixa, direto na carteira.
- **Opção só caixa:** R$ 100 mil; as ações emitidas vão para a tesouraria e o formador de mercado as vende perto do preço atual.
- Alternativa: oferta subsequente mensal (mini-bookbuilding no 1º dia do mês).
- Ranking mensal = rentabilidade do mês. Anual = rentabilidade desde a entrada, só para quem jogou 6+ meses.

## 4. Fontes de dados
- **Principal:** API-Football (grátis 100 req/dia; Pro US$ 19/mês). Confirmar cobertura de Série A/B, Copa do Brasil e estaduais no endpoint de ligas do Brasil.
- **Conferência:** football-data.org (grátis inclui Brasileirão Série A; 10 req/min). Chave via variável `FOOTBALL_DATA_KEY`, nunca commitada.
- Como só precisamos de resultados finais, o plano grátis basta: calendário 1×/dia + resultados ao fim dos jogos.
- Não raspar CBF/ge.globo (termos de uso). Painel de admin para corrigir placar manualmente.

## 5. Stack
- Next.js (React + TypeScript) na Vercel.
- Supabase: Postgres, login (Google e e-mail), realtime para cotações e livro.
- Motor de ordens em transações do Postgres; roda também o bookbuilding.
- Tarefa agendada: busca placares, fecha a rodada quando o último jogo termina e paga dividendos.
- Gráficos: Lightweight Charts.
- Regras de negócio como funções puras em TypeScript, testáveis com temporadas passadas.

## 6. MVP e roadmap
- **MVP:** só Brasileirão (Série A + Clube dos Treze na B). Login, R$ 100 mil, IPO por bookbuilding com rateio, livro de ofertas com formador de mercado, negociação livre, dividendos por ponto e colocação final, carteira, gráficos, rankings mensal e anual, admin.
- **Fora do MVP:** dividendos de copas, ligas entre amigos, premium, venda a descoberto, app mobile.
- **Fase 0 (agora):** motor + simulação da temporada 2025 com bots para calibrar IPO, quantidade de ações, dividendos e spread.
- **Fase 1:** MVP web, jogado por amigos no Brasileirão 2027.
- **Fase 2:** dividendos de copas, ligas entre amigos.
- **Fase 3:** premium (análise gráfica, ferramentas de trade), estaduais, notificações, PWA.

## 7. Estado atual e próximos passos

### Fase 0: concluída (2026-10-26), aguardando revisão
- Branch `fase-0` publicada, com o PR [thaiangomes/futbolsa#1](https://github.com/thaiangomes/futbolsa/pull/1) aberto para `main`.
- Entregue: bookbuilding, livro de ofertas (com `ledger.ts` de saldos e reservas), formador de mercado, dividendos, Brasileirão 2025 (380 jogos do openfootball, CC0), conversor e coletor da football-data.org, simulação com os 4 perfis de bots e README.
- `npm test`: 42 testes passando. `npm run typecheck`: sem erros. `npm run sim`: reproduzível, menos de 1 s; grava em `sim-output/` (fora do git, gere de novo).
- Mudança em relação ao plano, a confirmar com o Thaian: os negócios com o formador de mercado também contam no preço, e ele cota em volta do último negócio (`houseTradesSetPrice`, `--ancora lastTrade|peer`). Sem isso aparecia viés de alta.

### Achados da simulação (semente 2025, 100 bots, R$ 0,10 por ponto)
- IPO: 11 dos 20 clubes no piso da faixa, com sobra para a tesouraria; os 9 mais baratos tiveram rateio.
- Dividendos pequenos frente aos preços: de R$ 1,70 (Sport) a R$ 12,90 (Flamengo) por ação no ano; no IPO os preços somavam 2,2 vezes os dividendos.
- **A autocorreção pelos dividendos não apareceu.** A correlação entre preço e dividendos restantes ficou entre 0,3 e 0,5, e o preço chegou a 33 vezes os dividendos restantes no fim. Sobra ~65% do caixa após o IPO e nada dá valor à ação no fim da temporada, então quem define o nível de preço é o dinheiro.
- O bot de dividendos ficou quase só em caixa (+2%); momentum fez +304%.
- Com R$ 0,30 por ponto (`npm run sim -- --ponto 30`), o IPO fica perto do valor justo (0,8×), mas a alta continua.

### Dúvidas em aberto para o Thaian
1. A casa recompra as ações no fim da temporada (por exemplo, pelo dividendo da colocação final) para ancorar o preço?
2. Testar dividendo por ponto de R$ 0,30 a R$ 0,50?
3. Confirmar a proposta de entrada no meio da temporada (seção 3.6).
4. Confirmar a mudança do preço com negócios da casa (acima).

### Próximo passo provável
Segunda rodada de calibração da Fase 0 (valor de resgate no fim da temporada, dividendo maior, menos caixa livre, revisar o bot de dividendos), conforme as respostas acima. Depois, merge do PR e início da Fase 1. Continuar sem interface web, sem dinheiro real, sem escudos.

### Ambiente
- Node 20+. Numa máquina nova: `git clone https://github.com/thaiangomes/futbolsa.git`, `cd futbolsa`, `git checkout fase-0`, `npm install`, `npm test`.
- A chave da football-data.org fica só em `FOOTBALL_DATA_KEY` (veja `.env.example`), nunca no git.
- PRs abertos por Claude começam com estas duas linhas exatas:
   ```
   <!-- claude-projects-attribution -->
   _Requested by **Thaian** · [project thread](https://claude.ai/code/project/chan_01DgJga7JKgVUVAPtuCRx3PD?thread=cmsg_01DgJga7JKgVUVAPtuCRx3PDFzMLeYkx55KMm38SZDTqJV)_
   ```

### Como trabalhar com o Thaian
Ele gosta de acompanhar de perto: explique o que está fazendo, o que decidiu e por quê, e o resultado de cada etapa (testes, commits, erros).
