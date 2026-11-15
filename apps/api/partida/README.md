# Partida de teste (F17, etapa 1)

Jogar a temporada 2026 pelo site, como jogador comum, contra os bots, com o relógio andando quando o admin pede. É uma montagem
**à parte** da API (como `ensaio/` e `carga/`): `src/` nunca importa esta pasta, a pasta não vai à imagem Docker (`.dockerignore`) e
nenhuma variável de ambiente liga a rota do relógio na API do jogo público. Tudo em `127.0.0.1`, Postgres nativo (sem Docker).

## Como subir (Windows, 8 GB de RAM)

```bash
# 1. o Postgres local (a senha fica no seu ambiente, nunca em arquivo do repositório)
export TEST_DATABASE_URL=postgres://<usuario>:<senha>@localhost:5432/postgres

# 2. o site da partida (uma vez, ou quando o site mudar): constrói apps/web/out-partida, com o login falso e a API em 127.0.0.1:3200
npm run partida:site -w @futbolsa/web

# 3. a partida (cria o banco futbolsa_partida na primeira vez e retoma do mesmo instante nas seguintes)
npm run partida -w @futbolsa/api -- --escala 0,2
```

Opções: `--escala 0,2` (50 bots dos 9 perfis, padrão; só vale na primeira subida, depois a tela de bots do admin), `--apelido jogador`,
`--aprovar-sozinho` (o admin de teste aprova os pagamentos sozinho; sem isso a aprovação é um passo seu na tela de pagamentos).

Quando aparecer `PARTIDA PRONTA`:

| Endereço | Para quê |
|---|---|
| `http://127.0.0.1:3201/entrar/jogador` | entra como o jogador (R$ 100.000,00, aparece nos rankings) |
| `http://127.0.0.1:3201/entrar/admin` | entra como o admin (sem carteira, fora dos rankings); menu "Relógio da partida" |
| `127.0.0.1:3200` | a API; `127.0.0.1:3202` é a porta de controle do terminal |

A partida começa na abertura do IPO de 2026 (2026-01-14 19:00, horário de Brasília). Com o relógio parado os jogadores leem o mercado
e mandam ordens normalmente.

## O relógio

Dois estados: **pausado** (padrão ao ligar) e **tempo real** (um minuto de verdade é um minuto do jogo, com uma parada a cada 15 minutos do jogo).
Os saltos valem nos dois e depois o relógio volta ao estado em que estava: **1 dia**, **até a próxima rodada** (para quando termina o
último jogo da rodada e o fechamento dela já rodou) e **até uma data** (00:00 de Brasília). Um pedido de cada vez (o segundo recebe
"o relógio já está andando"). O relógio **nunca passa do último jogo terminado** nos dados: aparece "aguardando resultados reais", e
**atualizar** baixa os jogos de novo da ESPN e acrescenta uma foto nova em `partida_dados`.

Pela tela do admin (menu "Relógio da partida") ou pelo terminal, com a partida ligada:

```bash
npm run partida:relogio -w @futbolsa/api -- estado
npm run partida:relogio -w @futbolsa/api -- dia
npm run partida:relogio -w @futbolsa/api -- rodada
npm run partida:relogio -w @futbolsa/api -- ate 2026-02-01
npm run partida:relogio -w @futbolsa/api -- atualizar
npm run partida:relogio -w @futbolsa/api -- tempo-real
npm run partida:relogio -w @futbolsa/api -- pausar
```

**Zerar** só pelo terminal, com a partida desligada: `npm run partida:zerar -w @futbolsa/api -- --sim` (apaga o banco `futbolsa_partida`).

## Guardas

A partida recusa subir com `NODE_ENV=production`, com banco que não seja `localhost`, `127.0.0.1` ou `::1` (nem `?host=`) e com escuta
fora de `127.0.0.1`. Só mexe em bancos `futbolsa_partida*`. A porta de controle recusa quem manda `Origin` (uma página do navegador).
O login do site é o falso do build de teste (`/entrar/...`); a etapa 2 troca pelo login de verdade.

## Arquivos

| Arquivo | O que é |
|---|---|
| `partida.ts` | `subirPartida`: guardas, banco, carga (ou retomada), bots, relógio, site e porta de controle |
| `relogio.ts` | `RelogioFlutuante` e `RelogioDaPartida` (estados, saltos, limite, tempo real) |
| `modulo.ts` | o módulo Nest com `GET /admin/partida` e `POST /admin/partida/relogio` (só aqui) |
| `dados.ts` | as fotos dos dados em `partida_dados` e o "atualizar" |
| `banco.ts`, `guardas.ts`, `bots.ts`, `portas.ts` | banco persistente e tabelas, guardas, ritmo dos bots, portas |
| `iniciar.ts`, `servidor.partida.ts`, `comando.ts`, `zerar.ts` | os comandos do terminal |

Testes: `test/partida/` (`npm test` em `apps/api`). Dados de 2026: `packages/engine/data/*-2026.json` (`data/README.md`).
