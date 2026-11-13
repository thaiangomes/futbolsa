# Pagamentos de dividendos (`admin/payouts`)

Dono: módulo `admin` (quem recebe, aprovação, correção, estorno e caixa negativo). O desenho está no vault, em
`Técnica/Planos/Plano dos dividendos e pagamentos.md`. As regras de valor ficam no motor (`eventsFor`, `diffEvents`,
`settle`); os valores da temporada vêm do `dividends` (`SeasonValuesService`). **Feito: T0 a T10** (falta só o que a F13, a F14 e a F15 ligam).

## Arquivos
| Arquivo | O que faz |
|---|---|
| `engine-input.ts` | Monta o `EventsInput` do motor (jogos, classificação oficial importada na ordem, valores, clubes listados) e converte clube ↔ ticker (`EXT-<id>` para o clube sem ticker). |
| `holdings.ts` | `holdingsAt`: as ações de cada carteira no instante do fechamento (posição atual menos o que mudou depois), sem a tesouraria; grava e copia a foto (`payout_holdings`). Conta cada linha pelo horário real (`at`). |
| `close-events.service.ts` | A passada de fechamento: `eventsFor`, comparação com a versão vigente, evento novo `pending` com a foto, nova versão de um `pending` que mudou, `pending` que sumiu vira `superseded`. Só fecha o que passou da margem de 2 minutos. Ponto de extensão por tipo de evento (`registerSource`): a F15 registra a recompra. |
| `buyback-events.ts`, `buyback-close.service.ts` | A recompra (F15, T3): `BUYBACK_EVENTS` (a fonte do tipo `buyback`, ativa só com `trading_ended_at`) e o fechamento no fim da passada (`registerAfterPass`): com todas as competições fechadas há 2 minutos, trava temporada, clubes, carteiras com ordens e tesouraria, chama o `endTrading` da F9 e grava um evento `pending` por clube listado (inclusive R$ 0,00) com a foto em D = `trading_ended_at`. A recompra sai do `eventsFor` de agora (os dividendos que os resultados dão), nunca das linhas gravadas: assim o fechamento, a prévia refeita e o plano da correção fazem a mesma conta. `competition` gravada é `null` (o esquema não tem `temporada`). |
| `close-events.job.ts` | Dispara a passada a cada minuto, ao subir a API, a cada `MatchesChangedEvent` e a cada mudança da classificação. |
| `preview.service.ts`, `payouts.controller.ts` | `GET /admin/payouts` (prévia) e `GET /admin/payouts/:id/holders`. |
| `approve.service.ts` | `POST /admin/payouts/approve`: cada evento passa a `approved` numa transação curta, com o registro do admin e o aviso aos rankings. |
| `settle-credits.ts`, `settle.job.ts` | O crédito em lotes de até 50 carteiras (`SETTLE_BATCH`, medido na T10), retomável (tarefa de cada minuto e ao subir a API). |
| `settlement.ts` | Quais eventos aprovados ainda estão liquidando (a recompra também enquanto o clube tem ação em alguma conta). |
| `buyback-settle.ts` | A recompra aprovada (F15, T4): cada carteira da foto vende as ações à casa no lote da F12 (`postCredit` com linha `buyback`, custo `sale`, inclusive a R$ 0,00, e `payout_credits` mesmo com valor zero); depois de todas, `sweep` tira, sem pagar, as ações do clube que sobraram (tesouraria, conta excluída), com a tesouraria por último. Correção da recompra já paga: só dinheiro. |
| `correction-plan.ts`, `corrections.controller.ts` | `GET /admin/payouts/corrections`: o plano e a prévia da correção, com o código do plano. Não aplica nada. |
| `apply-correction.service.ts`, `settle-reversal.ts` | `POST /admin/payouts/corrections`: versões novas `approved` e antigas `superseded` numa transação (código do plano, `correction_stale`); o estorno por carteira cancela as compras de quem não cobre (`cancelBuysToCover`, usado também pela F14 com `annulment`) e o caixa pode ficar negativo. |
| `events.ts`, `outstanding.ts` | `payout.credited` (canal `me`) e `admin.pending` depois do `COMMIT`; `outstanding(temporada)` para o encerramento e `perShareTotals(temporada, clube)` para o simulador. |
| `ports.ts` | `RankingsPort` (aviso ao recálculo dos rankings da F13, dentro da transação, e `wake()` depois do `COMMIT`); a implementação vazia fica até a F13. |

## Regras que valem para quem mexer aqui
- Evento é identificado por (temporada, clube, `event_key`). Toda mudança cria versão nova (`version + 1`, `supersedes_id`); nada se edita.
- Quem recebe é quem tinha a ação no fechamento (foto), inclusive ações presas em ordens de venda. Bot e jogador bloqueado recebem; conta excluída e tesouraria não.
- Ordem das travas: temporada → clubes (ticker) → eventos de pagamento (id) → carteiras (id) → tesouraria. Nenhuma operação deste submódulo trava a tesouraria.
- O `RankingsPort.payoutsChanged` entra na mesma transação que cria, muda, aprova ou corrige o evento; os lotes de crédito não avisam.
- Nenhuma migração: o esquema da F4 tem tudo.
