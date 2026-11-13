# Módulo `entry`: entrada no meio da temporada (F11)

Quem cria a conta depois do fechamento do IPO escolhe como entrar: **carteira índice** (N ações de cada clube, valendo até R$ 70.000,00 a preços atuais, mais o resto em caixa) ou **só caixa** (R$ 100.000,00; as N ações vão para a tesouraria). O jogo **emite** as ações na hora. Regra: `Funcionalidades/Entrada no meio da temporada.md` do vault. Desenho e medição: `Técnica/Arquitetura da Fase 1.md` e `Técnica/Planos/Plano da entrada no meio da temporada.md`.

## Rotas

| Rota | O que faz |
|---|---|
| `GET /entry/preview` | Estado da entrada (`not_open_yet`, `settling`, `open`, `market_suspended`, `window_closed`, `already_entered`) e, em `open`, a conta da carteira índice. **Não trava nada** (P8). 30 por minuto. |
| `POST /entry` `{ mode }` | Confirma. 201 com a carteira nova; 200 com `repeated: true` para quem repete com o mesmo modo; 409 `already_entered` com outro modo. 5 por minuto. |

Erros: `entry_not_open`, `entry_not_ready`, `market_suspended`, `entry_window_closed`, `already_entered` (409), `account_blocked` (403) e `entry_busy` (503 com `Retry-After`).

## Arquivos

- `availability.ts`: `seasonGate` (estado da temporada, puro), `readAvailability` (sem trava, para a prévia e o `needsEntry`), janela pelos jogos da Série A, `findWallet`.
- `preview.service.ts`: `EntryPreviewService` e os preços de referência.
- `enter.service.ts`: `EntryService.enter` (a transação) e `enterBot` (o `admin` da F14 chama ao ligar um bot depois do IPO).
- `entry-gate.ts`: `EntryGate`, uma transação de entrada por vez por instância (até 50 esperam).
- `events.ts`: `wallet.changed` e `entry.added` do dono, depois do `COMMIT`.
- Regras puras no motor: `packages/engine/src/engine/entry.ts` (`entryWindow`, `referencePrice`, `entryQuote`).

## A transação (resumo)

1. `lock_timeout` 5 s e `statement_timeout` 15 s (P2): a entrada nunca fica pendurada.
2. Trava a temporada (compartilhada) e confere o estado dela.
3. Lê os jogos da Série A e os clubes listados **antes** da trava dos clubes.
4. **Trava todos os clubes por ticker.** Daqui ao `COMMIT` o mercado todo espera; por isso são poucos comandos (14 no índice, 16 no só caixa; teste: no máximo 24, com 20, 22 e 24 clubes).
5. Só agora lê o relógio (P3): o horário da carteira e do extrato nunca fica antes de um fechamento que aconteceu na espera.
6. Confere liquidação do IPO, janela e conta; vê se a carteira já existe (P6).
7. `entryQuote` com o preço de referência de cada clube (último negócio; sem negócio, o do IPO).
8. `total_shares += N` nos clubes, abre a carteira (`initial`) e grava as linhas `index_entry` pelo `portfolio.postMany`: na carteira do novato (índice) ou na da tesouraria, travada por último, com `ref = { entry, carteira do novato }` (só caixa).
9. `COMMIT`; depois, os avisos do canal `me`.

Soma acima de R$ 70.000,00 (`n = 0`): a carteira abre só com R$ 100.000,00, nada é emitido e a tesouraria nem é travada.

## Para quem mexe

- A ordem das travas é **temporada → clubes por ticker → carteiras → tesouraria**; o `LockOrderError` recusa fora dela. Não acrescente comandos depois do passo 4 sem pensar na trava: use o teste `enter-lock-budget.test.ts`.
- O dinheiro novo do jogo é só o caixa com que cada novato fica: na carteira índice ele "paga" N × soma pelas ações emitidas (o dinheiro some, as ações nascem); no só caixa, R$ 100.000,00.
- Medição da trava: `node --import tsx scripts/entry-lock-timing.mjs` (dentro de `apps/api`, com `TEST_DATABASE_URL`).
- Fora do escopo: pedir reposição da casa ao entrar (D3: as ações do só caixa aparecem nas cotações na reposição seguinte, até 3 horas).
