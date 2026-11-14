# Ensaio da temporada

Prova que as fases do jogo funcionam juntas, na API de verdade e com o relógio acelerado (F16, pista do ensaio). Plano: `Técnica/Planos/Plano do ensaio, carga e testes no navegador.md` do vault.

- **Ensaio rápido** (`npm test`, `test/ensaio/rapido.test.ts`): 2 rodadas do Brasileirão de 2025, Série B e copas sintéticas só com times de fora, 9 perfis de bot (1 ou 2 de cada), 4 jogadores por HTTP e WebSocket, da abertura do IPO ao encerramento (~6 min).
- **Ensaio completo**: `npm run ensaio -w @futbolsa/api` com `ENSAIO_ESCALA` (padrão 0.2; 1 = 250 bots), `ENSAIO_SEMENTE`, `ENSAIO_TICK` (180 = comparável com a simulação, 15 = ritmo de produção), `ENSAIO_MANTER=1`, `ENSAIO_SAIDA`. Precisa de `TEST_DATABASE_URL` (Postgres local; o ensaio cria o banco `futbolsa_ensaio_*` ao lado e o apaga). Escreve `ensaio-<data>.json`, `comparacao.md` e `comparacao.json`. Falha se uma medida exata (faixa do IPO, dividendos e recompra por ação) diferir da simulação com as regras do jogo.
- **No CI**: `.github/workflows/ensaio.yml` (sob demanda e toda segunda). Medido em 2026-11-14: `--escala 0.2` em ~40 min, `--escala 1` em ~79 min (564 MB).
- **Na máquina do Thaian** (8 GB): use `--escala 0.04` ou o ensaio rápido; um ensaio completo leva de 2 a 3 horas.
- O servidor de teste (`servidor.ts`) nunca liga num banco hospedado nem com `NODE_ENV=production`; `src/` não importa esta pasta.
