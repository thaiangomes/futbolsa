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

Dois estados: **pausado** (padrão ao ligar) e **tempo real** (um minuto de verdade é um minuto do jogo, com uma parada a cada 5 minutos do jogo: as passadas de produção e os bots reavaliam o mercado).
Os saltos valem nos dois e depois o relógio volta ao estado em que estava: **1 dia**, **até a próxima rodada** (para quando termina o
último jogo da rodada e o fechamento dela já rodou) e **até uma data** (00:00 de Brasília). Um pedido de cada vez (o segundo recebe
"o relógio já está andando"). **Atualizar** baixa os jogos de novo da ESPN e acrescenta uma foto nova em `partida_dados`.

O relógio **nunca passa do último jogo terminado** nos dados: aparece "aguardando resultados reais". **Exceção, para jogar durante os
jogos (item 23):** com dados baixados há menos de 12 minutos, tudo o que terminou até agora já está neles, e o relógio pode ir até a
**hora real** (nunca além dela). No tempo real, com o relógio a no máximo 30 minutos da hora real, a partida **baixa os dados da ESPN
sozinha a cada 5 minutos** e o relógio acompanha a hora de verdade, com jogo em andamento ou não. Se a ESPN falhar, os dados deixam de
ser frescos em 12 minutos e o tempo real pausa em "aguardando resultados reais" (peça "atualizar" quando ela voltar).

**Os bots durante os jogos (item 23):** no tempo real (paradas de 5 minutos) cada bot age com chance de 1 a cada 3 horas, uns 17
movimentos por hora com 50 bots (nos saltos do relógio o ritmo continua 0,25 a cada 3 horas). Com dados baixados há pouco e o
relógio perto da hora real, os bots também leem o **placar parcial** dos jogos do Brasileirão em andamento (a ESPN o traz nos
dados; o jogo continua "agendado" e sem placar para dividendos e classificação). O valor justo que o bot enxerga muda pelos pontos
esperados do clube: gols restantes como Poisson (mandante 1,45 e visitante 1,15 por jogo, na fração do jogo que falta), pontos
esperados com o placar de agora menos os do apito inicial, vezes o dividendo por ponto. 1 a 0 aos 70 minutos vale bem mais que 1 a 0
aos 10; 0 a 0 não muda nada. Copas, a colocação final e o valor justo da casa ficam de fora.

**Deixar o relógio pronto para os jogos:** peça **agora** (botão "Alcançar a hora real e ligar o tempo real" na tela do admin, ou
`npm run partida:relogio -- agora`). Ele baixa os dados, salta até a hora real (em um ou mais saltos; leva alguns minutos, passando
pelos fechamentos e bots do meio) e liga o tempo real. Dali em diante é só jogar; "pausar" para quando quiser.

Pela tela do admin (menu "Relógio da partida") ou pelo terminal, com a partida ligada:

```bash
npm run partida:relogio -w @futbolsa/api -- estado
npm run partida:relogio -w @futbolsa/api -- agora
npm run partida:relogio -w @futbolsa/api -- dia
npm run partida:relogio -w @futbolsa/api -- rodada
npm run partida:relogio -w @futbolsa/api -- ate 2026-02-01
npm run partida:relogio -w @futbolsa/api -- atualizar
npm run partida:relogio -w @futbolsa/api -- tempo-real
npm run partida:relogio -w @futbolsa/api -- pausar
```

**Zerar** só pelo terminal, com a partida desligada: `npm run partida:zerar -w @futbolsa/api -- --sim` (apaga o banco `futbolsa_partida`).

## Jogar pelo celular, na rede Wi-Fi de casa

Opção explícita, **desligada por padrão**: com ela a API e o site escutam no endereço da máquina na rede privada (e não mais em
127.0.0.1), e o celular, no mesmo Wi-Fi, abre o site por esse endereço. A porta de controle do terminal (3202) continua só em 127.0.0.1.

> **Aviso:** o login da partida é falso. Enquanto a opção estiver ligada, **qualquer aparelho do Wi-Fi** que abrir
> `http://<ip>:3201/entrar/jogador` ou `/entrar/admin` entra como o jogador ou como o admin. Use só em rede de casa, de gente de confiança,
> e volte a subir sem a opção quando terminar. Nunca em rede pública (café, trabalho, hotel).

1. **Descubra o IP da máquina na rede de casa:** `ipconfig` e olhe o "Endereço IPv4" do adaptador Wi-Fi (algo como `192.168.0.23`). A trava só
   aceita endereços de rede privada (`192.168.x.x`, `10.x.x.x`, `172.16.x.x` a `172.31.x.x`); com `0.0.0.0` ou um endereço público a partida
   se recusa a subir. O IP do roteador pode mudar: se o celular não abrir, confira o IP de novo.
2. **Libere o Firewall do Windows, só para rede privada, nas portas 3200 e 3201** (quem cria a regra é você; a partida não mexe no firewall).
   Num PowerShell **como administrador**:
   ```powershell
   New-NetFirewallRule -DisplayName "FutBolsa partida (rede privada)" -Direction Inbound -Protocol TCP -LocalPort 3200,3201 -Profile Private -Action Allow
   ```
   A rede do Wi-Fi precisa estar marcada como **Particular** (Configurações → Rede e Internet → Wi-Fi → a rede → "Particular"); em rede
   "Pública" a regra não vale. Para apagar a regra depois: `Remove-NetFirewallRule -DisplayName "FutBolsa partida (rede privada)"`.
3. **Construa o site apontando a API para esse IP** (o último `--api` vale):
   ```bash
   npm run partida:site -w @futbolsa/web -- --api http://192.168.0.23:3200
   ```
4. **Suba a partida com a opção** (com a partida antiga desligada):
   ```bash
   npm run partida -w @futbolsa/api -- --escala 0,2 --rede-privada 192.168.0.23
   ```
5. No celular, no mesmo Wi-Fi: `http://192.168.0.23:3201/entrar/jogador`. No computador, use o mesmo endereço (a escuta não é mais em 127.0.0.1).

Para voltar ao modo só local: refaça o passo 3 sem o `-- --api` e suba a partida sem `--rede-privada`.

## Guardas

A partida recusa subir com `NODE_ENV=production`, com banco que não seja `localhost`, `127.0.0.1` ou `::1` (nem `?host=`) e com escuta
fora de `127.0.0.1` (a única exceção é a opção `--rede-privada <ip>`, só com endereço de rede privada). Só mexe em bancos `futbolsa_partida*`. A porta de controle recusa quem manda `Origin` (uma página do navegador).
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
