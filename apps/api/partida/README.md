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
Na etapa 1 o login do site é o falso do build de teste (`/entrar/...`); a etapa 2 (abaixo) usa o de verdade.

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

# Etapa 2: até 10 convidados (F17, T9)

O site fica na **Vercel**, a API e o banco ficam no **seu computador** e a API sai para a internet por um **túnel HTTPS**. O banco
nunca sai: o túnel só leva até `127.0.0.1:4000`, que é a API. O login é o do **Supabase de produção** (decisão D7); só entra quem o
admin convidou. Os bots e as contas internas (o admin que carrega a temporada) falam com a API por dentro do processo.

```
convidado → https://<site>.vercel.app  →  https://<domínio>.ngrok-free.app  →  127.0.0.1:4000 (API da partida)  →  Postgres local
                  (site estático)             (túnel, só HTTP e WebSocket)                                      (nunca exposto)
```

Cada convidado tem **uma conta de jogador**. Você precisa de **duas contas** suas: a de jogador (e-mail convidado, como todos) e a de
admin (o e-mail de `ADMIN_BOOTSTRAP_EMAIL`; sem carteira e fora dos rankings). Use dois e-mails.

## O que só você faz (contas e painéis)

Nada disso foi feito pelo código, e **nenhuma chave vai para arquivo, README, chat ou log**: cada valor abaixo você digita no painel
ou no terminal, na hora. A chave de serviço do Supabase **não é usada** na partida.

### 1. Túnel (ngrok, domínio fixo grátis, decisão D8)
1. Crie a conta em ngrok.com e instale: `winget install ngrok.ngrok`.
2. No painel (Your Authtoken), copie o token e rode **uma vez**: `ngrok config add-authtoken <seu token>` (fica na configuração do ngrok, fora do repositório).
3. No painel, em Domains, anote o **dev domain grátis** (`<nome>.ngrok-free.app`; é fixo e não muda ao reiniciar).
4. Para ligar o túnel (com a partida de pé): `ngrok http --inspect=false --url=https://<nome>.ngrok-free.app 127.0.0.1:4000` (sem `--inspect=false` o painel local do ngrok, em `127.0.0.1:4040`, guarda os cabeçalhos `Authorization` dos convidados).

Limites do plano grátis (conferidos em 2026-11-15 em ngrok.com/docs/pricing-limits/free-plan-limits): **1 GB de saída por mês**,
**20.000 requisições HTTP por mês** (4.000 por minuto), 3 endpoints, sem limite de tempo da sessão. A página **não diz** se as
conexões WebSocket entram na conta de requisições nem o que acontece ao estourar. O WebSocket funciona na API da partida (conferido
em 2026-11-15 direto na API, sem o ngrok no meio); confira com o túnel de verdade no passo 6 do roteiro abaixo. O ngrok mostra uma
página de aviso para navegador em páginas HTML, que não deve atingir as respostas JSON da API; **confira no primeiro teste** (se o
login ou o mercado falharem no celular, é isso).

Conta de requisições: o site pergunta a hora do jogo a cada 20 segundos por aba aberta, mais as telas (cada tela faz de 3 a 8
chamadas). Estimativa (não medida): uma pessoa com o site aberto por 1 hora gasta de 300 a 600 requisições; **10 pessoas em 3 ou 4
sessões de 1 hora chegam perto dos 20.000**. Se o túnel parar por limite no meio do mês, use o plano B.

**Plano B, Tailscale Funnel** (grátis, endereço fixo `<máquina>.<rede>.ts.net`, sem limite mensal de requisições publicado; a
conferir quando for usar): instale o Tailscale, ative HTTPS e o Funnel no painel e rode `tailscale funnel 4000`. Troque o endereço
nos passos 2 e 3.

### 2. Supabase (projeto de produção, decisão D7)
No painel do projeto, **Authentication → URL Configuration**:
- **Site URL**: pode continuar a de produção do jogo. A partida usa só a lista abaixo.
- **Redirect URLs**: acrescente `https://<site>.vercel.app/**` (o endereço do passo 3). Sem isso o e-mail de confirmação e o de nova
  senha voltam para o endereço errado.

Não crie usuários à mão: cada convidado cria a senha no "Primeiro acesso" do site (o Supabase manda o e-mail). O plano grátis limita
os e-mails por hora e o limite é **dividido com o lançamento**; convide em lotes. As contas de teste ficam na lista de usuários
(Authentication → Users) até você apagar.

### 3. Vercel (site da partida)
Crie um **projeto novo e separado do jogo público** (a flag `NEXT_PUBLIC_PARTIDA` nunca deve estar no site do lançamento):
1. Add New → Project → importe o repositório; **Root Directory**: `apps/web`; Framework: Next.js; o resto no padrão.
2. **Environment Variables** (Production), todas públicas por natureza:
   - `NEXT_PUBLIC_PARTIDA` = `1`
   - `NEXT_PUBLIC_API_URL` = `https://<nome>.ngrok-free.app` (sem barra no fim)
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://<projeto>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = a chave **pública** (publishable) do Supabase

   **Nunca** ponha aqui a chave de serviço (`SUPABASE_SERVICE_ROLE_KEY`): a partida não a usa.
3. Deploy. O endereço (`https://<site>.vercel.app`) é o `WEB_ORIGIN` da subida e o que entra nos Redirect URLs do Supabase.

Outro jeito, sem ligar o repositório: construa aqui e publique a pasta pronta
(`npm run partida:site:publico -w @futbolsa/web -- --api https://<nome>.ngrok-free.app`, com `NEXT_PUBLIC_SUPABASE_URL` e
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` no ambiente; sai em `apps/web/out-partida-publica`) e `npx vercel deploy apps/web/out-partida-publica --prod`.
O build pesa na memória: se o computador estiver apertado, prefira a Vercel construir.

## Subir a partida aberta a convidados

No PowerShell. A senha do Postgres **não** é digitada na linha de comando: o PowerShell guarda o que você digita em
`ConsoleHost_history.txt`. Use `Read-Host`, que não grava a resposta, e desligue o histórico desta janela:

```powershell
Set-PSReadLineOption -HistorySaveStyle SaveNothing
$senha = Read-Host "senha do Postgres" -AsSecureString
$env:TEST_DATABASE_URL = "postgres://<usuario>:" + [System.Net.WebUtility]::UrlEncode([System.Net.NetworkCredential]::new("", $senha).Password) + "@localhost:5432/postgres"
$env:SUPABASE_URL = "https://<projeto>.supabase.co"
$env:ADMIN_BOOTSTRAP_EMAIL = "<o e-mail da sua conta de admin>"
$env:WEB_ORIGIN = "https://<site>.vercel.app"
npm run partida -w @futbolsa/api -- --publica --escala 0,2
```

A partida pública **não usa nem recebe a chave de serviço do Supabase** (`SUPABASE_SERVICE_ROLE_KEY`): excluir a conta na partida não
apaga a conta de login do Supabase de produção (continua na lista de usuários até você apagar). Pelo mesmo motivo, e-mails
`@exemplo.com` (os das contas internas da partida) nunca entram pelo Supabase. Rode `ngrok config add-authtoken` e o token também
fora do histórico (`Set-PSReadLineOption -HistorySaveStyle SaveNothing` na mesma janela).

Em outro terminal: `ngrok http --inspect=false --url=https://<nome>.ngrok-free.app 127.0.0.1:4000`. A mensagem `PARTIDA PRONTA` diz "ABERTA A CONVIDADOS".
A partida **recusa subir** sem `SUPABASE_URL`, `ADMIN_BOOTSTRAP_EMAIL` ou com `WEB_ORIGIN` que não seja o
endereço `https` do site (sem barra no fim). Nesse modo o servidor não serve o site nem as páginas `/entrar/...` do login falso, e
não cria a conta de jogador de teste. O relógio, o terminal e o zerar são os mesmos da etapa 1 (a porta de controle `3202` continua só local).
`PARTIDA_BANCO=futbolsa_partida_<sufixo>` usa outro banco ao lado do da partida (para conferir sem mexer no jogo).

### Convidar
1. **Antes de divulgar o site a qualquer pessoa**, abra `https://<site>.vercel.app`, "Primeiro acesso" com o **e-mail do admin**, confirme o e-mail e entre: o primeiro login desse e-mail cria a conta de admin sem convite. Confira em Authentication → Users que existe **um** usuário com esse e-mail, já confirmado (se o cadastro estiver aberto, outra pessoa poderia ter se cadastrado com ele antes).
2. No menu do admin, em convites, ponha os e-mails dos convidados (até 10) e o seu de jogador. Só quem tem convite cria conta; quem não tem cai em "sem convite".
3. Cada convidado abre o site, faz o "Primeiro acesso" e entra. Com o IPO aberto a conta já nasce com R$ 100.000,00.
4. O admin usa "Relógio da partida" (ou o terminal) como na etapa 1.

### Conferir com um segundo aparelho (critério 17)
Com a partida, o túnel e o site de pé: no celular (rede móvel, fora do Wi-Fi de casa) abra `https://<site>.vercel.app`. Confira:
(1) a tela inicial mostra "Tempo real: conectado"; (2) o e-mail **convidado** entra, e um e-mail **sem convite** cai em "sem convite";
(3) em Mercado, a lista de clubes (depois de o IPO fechar) e o livro de um clube aparecem, e uma ordem sua aparece no livro do outro
aparelho sem recarregar (WebSocket pelo túnel); (4) com o IPO aberto, a tela do IPO aceita ofertas (a hora do jogo vem da API).

## Se faltar memória (Windows, 8 GB)
- Só rodam: o serviço do Postgres, **um** processo Node da partida e o `ngrok` (leve). Docker desligado; feche o navegador com muitas abas e as outras sessões.
- Não construa o site aqui: deixe a Vercel construir.
- A partida usa cerca de 1 GB. Se o Windows ficar lento, pare a partida com **Ctrl+C**: o estado está no banco; ao subir de novo volta do mesmo instante, **pausado**.
- Para menos bots, só na primeira subida: `--escala 0,1`. Depois, a tela de bots do admin.
- Para limitar o Node: `$env:NODE_OPTIONS = "--max-old-space-size=1536"` antes de subir.
- O computador **dormindo** derruba o jogo para todos (o estado se mantém); desligue o modo de espera enquanto os convidados jogam.

## Segurança em uma página
- Sai pelo túnel **só a API**; a partida recusa banco que não seja local. Confira se o Postgres só escuta em `localhost` (o instalador do Windows às vezes deixa `listen_addresses = '*'`): no `psql`, `SHOW listen_addresses;`; se não for `localhost`, mude em `postgresql.conf` e reinicie o serviço `postgresql-x64-17`. A porta de controle (`3202`) é local e recusa quem manda `Origin`.
- A rota do relógio (`/admin/partida/...`) só existe nesta montagem e só o admin passa (401 sem login, 403 para jogador). `GET /partida/hora` é pública e devolve só o instante do jogo.
- O CORS e o WebSocket só aceitam `WEB_ORIGIN`. No modo público o tempo real aceita no máximo 200 conexões e 500 mensagens por segundo por conexão (a simulação relaxa esses limites). Atrás do túnel o limite de taxa conta pelo IP de quem chama (`X-Forwarded-For` do ngrok), não pelo túnel.
- Os servidores locais da etapa 1 (site e porta de controle) só atendem `Host` local.
- O login é a assinatura do Supabase (chaves públicas do projeto); o prazo do token conta no relógio de verdade, não no do jogo. Só e-mail convidado cria conta.
- Desligue o `ngrok` quando não houver teste: sem túnel nada fica exposto.

## Limitações conhecidas (revisão de segurança de 2026-11-15)
- **Cota do túnel:** quem souber o endereço da API (ele está no JavaScript do site) pode gastar a cota de 20.000 requisições do ngrok grátis,
  e o limite de taxa da API não ajuda porque o ngrok conta antes. Se acontecer, desligue o túnel; o plano B (Tailscale Funnel) não tem essa cota.
  Reduzir isso exige um limite no próprio ngrok (Traffic Policy), a conferir no plano grátis.
- **Token em sessão longa:** o site da partida troca o `Date` do navegador pelo relógio do jogo; o login do Supabase decide pelo `Date.now()` se o
  token venceu e por isso só renova depois de um 401 (1 requisição a mais por hora por convidado). Funciona; a conferir numa sessão de mais de 1 hora.
