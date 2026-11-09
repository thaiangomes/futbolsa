# Pagamentos de dividendos (`admin/payouts`)

Dono: módulo `admin` (quem recebe, aprovação, correção, estorno e caixa negativo). O desenho está no vault, em
`Técnica/Planos/Plano dos dividendos e pagamentos.md`. As regras de valor ficam no motor (`eventsFor`, `diffEvents`,
`settle`); os valores da temporada vêm do `dividends` (`SeasonValuesService`). **Feito até aqui: T0 a T6.** A correção
com estorno (T7) espera a F9 (`market.cancelOrders`).

## Arquivos
| Arquivo | O que faz |
|---|---|
| `engine-input.ts` | Monta o `EventsInput` do motor (jogos, classificação oficial importada na ordem, valores, clubes listados) e converte clube ↔ ticker (`EXT-<id>` para o clube sem ticker). |
| `holdings.ts` | `holdingsAt`: as ações de cada carteira no instante do fechamento (posição atual menos o que mudou depois), sem a tesouraria; grava e copia a foto (`payout_holdings`). Conta cada linha pelo horário real (`at`). |
| `close-events.service.ts` | A passada de fechamento: `eventsFor`, comparação com a versão vigente, evento novo `pending` com a foto, nova versão de um `pending` que mudou, `pending` que sumiu vira `superseded`. Só fecha o que passou da margem de 2 minutos. Ponto de extensão por tipo de evento (`registerSource`): a F15 registra a recompra. |
| `close-events.job.ts` | Dispara a passada a cada minuto, ao subir a API, a cada `MatchesChangedEvent` e a cada mudança da classificação. |
| `preview.service.ts`, `payouts.controller.ts` | `GET /admin/payouts` (prévia) e `GET /admin/payouts/:id/holders`. |
| `approve.service.ts` | `POST /admin/payouts/approve`: cada evento passa a `approved` numa transação curta, com o registro do admin e o aviso aos rankings. |
| `settle-credits.ts`, `settle.job.ts` | O crédito em lotes de até 200 carteiras, retomável (tarefa de cada minuto e ao subir a API). |
| `settlement.ts` | Quais eventos aprovados ainda estão liquidando. |
| `correction-plan.ts`, `corrections.controller.ts` | `GET /admin/payouts/corrections`: o plano e a prévia da correção, com o código do plano. Não aplica nada. |
| `ports.ts` | `RankingsPort` (aviso ao recálculo dos rankings da F13, dentro da transação, e `wake()` depois do `COMMIT`); a implementação vazia fica até a F13. |

## Regras que valem para quem mexer aqui
- Evento é identificado por (temporada, clube, `event_key`). Toda mudança cria versão nova (`version + 1`, `supersedes_id`); nada se edita.
- Quem recebe é quem tinha a ação no fechamento (foto), inclusive ações presas em ordens de venda. Bot e jogador bloqueado recebem; conta excluída e tesouraria não.
- Ordem das travas: temporada → clubes (ticker) → eventos de pagamento (id) → carteiras (id) → tesouraria. Nenhuma operação deste submódulo trava a tesouraria.
- O `RankingsPort.payoutsChanged` entra na mesma transação que cria, muda, aprova ou corrige o evento; os lotes de crédito não avisam.
- Nenhuma migração: o esquema da F4 tem tudo.
