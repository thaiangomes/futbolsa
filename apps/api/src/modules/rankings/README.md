# Rankings mensal e anual (F13)

Plano: `Técnica/Planos/Plano dos rankings.md` no vault. Regras: `Funcionalidades/Rankings mensal e anual.md`.

## O que mora aqui
| Arquivo | Para quê |
|---|---|
| `equity-at.ts` | `equityAtWallets(tx, seasonId, at, carteiras)`: adapta o `EquityAt` da carteira (F10), a única implementação do patrimônio num instante. Nenhum SQL de patrimônio aqui. |
| `participants.ts` | Quem aparece (`participants`), como aparece (`identities`) e `participantsByIds` (o recálculo mantém o conjunto do oficial). Só `SELECT`. |
| `base.ts` | `baseOf`: R$ 100.000,00 para quem entrou depois do fechamento anterior; senão a linha da **versão atual** do oficial anterior, completada pelo histórico. |
| `build-ranking.ts` | Posições pelo `rank` do motor; quem está sem base (≤ 0) fica depois de todos, empatado (P8). |
| `close.ts`, `close.service.ts` | `closeMonth`, `closeSeason`, `closeMonthsDue` e a tarefa `rankings-close` (a cada minuto, com a folga da F10). Idempotente, sem travar carteira. |
| `recalc.ts`, `recalc.service.ts` | Pedido de recálculo (`ranking_recalc_requests`, um aberto por temporada), atendimento em ordem (cascata), versões novas só se algo mudou, e o `RankingsPortAdapter` que a F12 chama. |
| `live.service.ts` | A parcial: um cálculo para todos, guardado por 5 s; `GET /rankings/live`; evento `rankings.live` (tarefa de 10 s, só se algo mudou). |
| `official.service.ts`, `rankings.controller.ts` | `GET /rankings/month/:yyyy-mm`, `/season/:ano`, `/history`, `/live`. Todas públicas, sem patrimônio nem base em R$ (P7). |
| `rankings.service.ts` | A porta para os outros módulos (F14, F15, F16). |
| `view.ts`, `snapshots.ts` | Linha como a tela vê (chave opaca da carteira) e leitura/gravação das versões. |

## Regras que não se quebram
- O instante de cada ranking é o `closed_at` **nominal** (23:59 de Brasília do último dia, ou o instante do encerramento), nunca a hora em que a tarefa rodou.
- `created_at`, `requested_at` e `done_at` vêm do `Clock`; nada usa `now()` do SQL.
- O recálculo lê o histórico e **não trava** carteira nem clube; roda em `REPEATABLE READ`. O fechamento também.
- O conjunto de quem aparece num ranking fechado nunca muda no recálculo; só patrimônio, base e posição.

## Chamadas dos outros módulos
- **F12:** `RankingsPort.payoutsChanged(tx, …)` grava o pedido na transação do pagamento; `wake()` atende depois do `COMMIT`.
- **F15:** `RankingsService.closeMonthsDue(tx, seasonId, instante)`, `closeSeason(tx, { seasonId, at })` e `pendingRecalc(tx, seasonId)` (para `closeBlockers`).
- **F14:** a chave `seasons.bots_in_rankings` e o status da conta são lidos na hora; a anulação de negócios (T12) chamará `requestRecalc`.

## Medida
`RANKINGS_SCALE=1 npx vitest run test/rankings/scale.test.ts` fecha um mês com 10 mil carteiras e 5 posições cada e imprime o tempo.
