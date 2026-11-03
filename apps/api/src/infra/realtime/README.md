# Tempo real (WebSocket)

Conexão do site com a API em `/ws`, em `ws` puro (sem socket.io), com um envelope próprio:

```json
{ "type": "trade", "channel": "club:FLA3", "seq": 1793631600042, "at": "2026-11-02T15:00:00.000Z", "data": { } }
```

O plano e as decisões estão no vault (`Técnica/Planos/Plano do WebSocket.md` e `Técnica/Arquitetura da Fase 1.md`). Aqui fica só o que quem mexe no código precisa.

## Como os módulos de negócio usam

Os módulos só falam com o `EventBus` (`bus.ts`). Nenhum importa o gateway.

```ts
// dentro da transação do serviço dono (F4): o evento só sai depois do COMMIT
tx.afterCommit(() => bus.publish("club:FLA3", "trade", { id, price, quantity, at }));
tx.afterCommit(() => bus.publish(meChannel(userId), "wallet.changed", { cash, reserved, club, shares }));

// na rota REST que devolve uma foto: o seq vem ANTES da leitura do banco
const seq = bus.currentSeq("club:FLA3");
const book = await readBook(tx, ticker);
return { ...book, seq };
```

- `publish(canal, tipo, dados)` confere que o tipo pertence ao canal (catálogo em `packages/contracts/src/realtime/events.ts`). Evento novo: acrescente ao catálogo e, se quiser conferir o conteúdo, registre o esquema com `bus.registerSchema(tipo, zod)`.
- **Todo evento é seguro de aplicar duas vezes**: ou leva o valor absoluto (o livro inteiro, o caixa e a posição) ou um identificador para descartar o repetido (negócio, linha do extrato). É por isso que ler o `seq` antes do banco não perde nada: no pior caso o cliente recebe de novo um evento que a foto já continha.
- **Não limite a taxa no módulo.** `throttle.ts` junta por tipo: `book` 250 ms por clube, `price` 1 s por clube, `rankings.live` 10 s. O primeiro sai na hora, o último sempre sai e leva o valor mais recente; o `seq` só é gasto na saída, então não há buraco.
- O canal `me` é por pessoa: use `meChannel(userId)`. O cliente nunca escolhe de quem é o `me`.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `gateway.ts` | Aceita a conexão em `/ws` (origem conferida), registra as sessões, desliga com 1001, `disconnectUser`, `stats()` |
| `protocol.ts` | Uma sessão por conexão: `auth` só como primeira mensagem, `subscribe`/`unsubscribe`, acesso por canal, ritmo e cliente lento |
| `bus.ts`, `memory-bus.ts` | O barramento: `seq` por canal, histórico curto, retomada por `since` |
| `throttle.ts` | Limitação por tipo de evento |
| `authenticator.ts`, `auth-from-accounts.ts`, `fake-authenticator.ts` | A porta do login (`RealtimeAuthenticator`). Em produção vale o `AuthFromAccounts` (`AuthVerifier` + `UserResolver` da F5); o `FakeRealtimeAuthenticator` é só dos testes |
| `limits.ts` | Os limites, lidos do ambiente a cada conexão |
| `lifecycle.ts` | `heartbeat`, `ping` e a vida máxima da conexão autenticada |
| `stats.ts` | Contadores (atraso de entrega) |

## Regras que vale conhecer

- **`seq`**: por canal, de 1 em 1. Começa no horário em milissegundos da primeira vez que o canal aparece depois da API subir, então depois de um reinício ele é sempre maior que o de antes: o cliente vê um salto, trata como buraco e recarrega pela REST.
- **Retomada**: `subscribe` com `since` reenvia o que faltou (últimos 200 eventos ou 60 s nos canais públicos; 50 ou 5 min no `me`). Passado disso, a resposta é `mode: "resync"` e o cliente recarrega pela REST. A retomada é síncrona dentro do tratamento do `subscribe`: nenhum evento novo entra entre o reenvio e o ao vivo.
- **Acesso**: `season`, `prices`, `rankings` e `club:<ticker>` são públicos. `me` exige login e é só do dono (o jogador bloqueado também assina). `admin` é só de admin. O ticker é validado pelo formato (`AAA9`); a lista de clubes listados é da F9.
- **Login**: o token do `auth` vai pelo `AuthVerifier`. Token recusado → `invalid_token` e 4401. Sem conta do jogo ou e-mail sem confirmação → `no_account`; conta excluída → `account_deleted`; nos dois a conexão segue como visitante. O bloqueado entra. Para derrubar alguém (exclusão, bloqueio, mudança de papel) chame `RealtimeGateway.disconnectUser(userId)`: as conexões fecham com 4403 e o site reabre com o login atual.
- **Vida da conexão**: a autenticada fecha com 4402 depois de 55 minutos (o token só é conferido na abertura); o cliente reabre com token novo.

## Códigos de fechamento

| Código | Quando | O cliente faz |
|---|---|---|
| 1001 | API desligando | Reconecta com recuo |
| 1008 | Mais de 20 mensagens por segundo | Reconecta com recuo |
| 1009 | Mensagem maior que 4 KB | Reconecta com recuo |
| 1013 | API cheia, ou a 6ª conexão da mesma pessoa derrubando a mais antiga | Reconecta com recuo |
| 4401 | Token inválido | Pede token novo uma vez; se falhar, vira visitante |
| 4402 | Passou dos 55 minutos | Reabre na hora com token novo |
| 4403 | Conta excluída ou papel mudou (`disconnectUser`) | Reabre como o login atual manda |
| 4408 | Nenhuma mensagem válida em 10 segundos | Reabre |

O cliente lento (mais de 1 MB parado no envio) é cortado sem quadro de fechamento: quem não lê não receberia o código.

## Configuração (variáveis de ambiente)

`WEB_ORIGIN` (origem aceita no `upgrade`; sem ela vale tudo, como o CORS), `WS_MAX_CONNECTIONS` (20000), `WS_MAX_CONNECTIONS_PER_USER` (5), `WS_MAX_SUBSCRIPTIONS` (40), `WS_MAX_MESSAGES_PER_SECOND` (20), `WS_SLOW_CLIENT_BYTES` (1 MB), `WS_FIRST_MESSAGE_TIMEOUT_MS` (10000), `WS_HEARTBEAT_MS` (25000), `WS_PING_MS` (30000), `WS_MAX_AGE_MS` (55 min). Os limites são lidos a cada conexão; o tamanho máximo da mensagem (4 KB) é fixo. Os números são iniciais: o teste de carga da F16 mede e ajusta.

## Testes e medição

```bash
npm test -w @futbolsa/api -- test/realtime   # precisa do Postgres de teste (o setup global do vitest o usa; só o login.test.ts usa banco de fato)
npm test -w @futbolsa/web                    # rastreador de seq, recuo, cliente, canal sincronizado e ganchos
npm run build -w @futbolsa/api && node apps/api/scripts/ws-fanout.mjs 1000 100
```

O `ws-fanout.mjs` sobe a API compilada no próprio processo, abre as conexões, publica os eventos e imprime o atraso de entrega (p50/p95) e a memória. Cliente e servidor dividem a máquina e o laço de eventos, então o número é um teto de custo, não de latência de rede.

## Trocar o barramento (mais de uma instância)

`EventBus` é uma classe abstrata e o `MemoryEventBus` é a única implementação. Com mais de uma instância da API, a troca é por `LISTEN/NOTIFY` do Postgres (e o `seq` por uma sequência no banco), sem mexer nos módulos que publicam.
