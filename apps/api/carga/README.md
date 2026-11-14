# Carga (F16, pista B)

O teste de carga da API: um **gerador** num processo e a **API** (o servidor da carga) em outro, contra um Postgres.

```
npm run carga -w @futbolsa/api -- --escala leve --cenario pico
```

Precisa de `TEST_DATABASE_URL` (um Postgres; o banco da carga é criado ao lado e apagado no fim). Opções:

| opção | valores |
|---|---|
| `--escala` | `leve` (150 jogadores, 200 conexões, 20 ordens/s), `pico` (600 jogadores, 2.000 conexões, 100 ordens/s), `completa` (10.000 jogadores e conexões; só no CI) |
| `--cenario` | `pico`, `degraus`, `tesouraria`, `reconexao`, `leituras`, `bots`, `encerramento`, uma lista com vírgulas ou `todos` |
| `--saida` | pasta dos relatórios (padrão `carga-saida`, ignorada pelo git): um `.json` e um `.md` por cenário |
| `--manter` | não apaga o banco no fim |

## Como é montado

- `servidor.ts` / `servidor.carga.ts`: a API inteira (o app de teste da P1) com o relógio andando em tempo real, os medidores da T15 ligados
  e uma **porta de controle** local (tokens de teste, medidas, reposição da casa, bots, tarefas de patrimônio). Roda pelo vitest só
  para ter o SWC (metadados de decorador do Nest).
- `populacao.ts`: a temporada em pregão, a tesouraria e N jogadores. Usuários, identidades e carteiras entram em lote (um `INSERT`
  por mil); extrato e posições passam pelo livro-razão (`postMany`), e o IPO fica registrado (ofertas, alocações e resultado), para o
  verificador de invariantes da T8 valer no fim de cada cenário.
- `trafego.ts`: ordens limitadas perto do preço, a mercado, cancelamentos e leituras, de **malha aberta** (as chamadas saem na hora
  marcada, sem esperar a resposta: é isso que deixa a fila aparecer). Metade das ordens vai para o clube quente (o primeiro ticker).
  O servidor limita 60 ordens por minuto por pessoa, então o ritmo máximo é o número de jogadores por segundo.
- `conexoes.ts`: as conexões WebSocket assinam `prices`, `club:<quente>` e `me`, medem o atraso de cada evento pelo `at` do envelope
  e, se caem, reabrem com recuo e sorteio.
- `medidores.ts`: o histograma (precisão de 1%) que guarda espera e retenção de cada trava, repetições por *deadlock* e o atraso dos
  eventos no servidor.
- `cenarios/`: (a) pico, (b) degraus, (c) tesouraria, (d) reconexão em massa, (e) leituras com histórico grande (`historico.sql`) e as
  tarefas de patrimônio, (f) bots, (g) encerramento (ainda sem cenário; veja o relatório dele).

## Os números desta máquina não dimensionam o servidor

O gerador, a API e o Postgres dividem os mesmos núcleos. As latências saem **pessimistas**, e o CI (2 a 4 núcleos compartilhados) também
não é o servidor de verdade. Servem para comparar uma execução com outra e achar **gargalos de código** (quantas consultas dentro da
trava, quem espera quem), que valem em qualquer máquina.

## Repetir o teste apontando para a Azure, depois do deploy

O gerador precisa de duas coisas que a API de produção não tem de propósito: tokens de teste e acesso direto ao banco. Por isso a
carga **não** roda contra o `api.futbolsa...` real. Duas formas de repetir na Azure:

1. **Ambiente de teste na Azure** (recomendado): o mesmo contêiner da API, num grupo de recursos à parte, com o Postgres próprio, e
   `carga/servidor.carga.ts` rodando no lugar do `main.js` (ou numa VM ao lado). Com `CARGA_DATABASE_URL` apontando para o banco de
   teste (a guarda do ensaio recusa bancos do Supabase), `npm run carga` troca só a máquina; os números passam a ser os do tamanho
   da instância. O `apiUrl` e o `controleUrl` que o servidor escreve no arquivo `CARGA_PRONTO` são os que o gerador usa.
2. **Gerador remoto**: rodar o gerador numa VM da mesma região e deixar a API e o banco como estão, para tirar o gerador do mesmo
   núcleo. Hoje o `executar.ts` sobe o servidor por conta própria; para este uso, passar `--api` e `--controle` ainda não existe
   (é um acréscimo pequeno em `executar.ts`, a fazer quando houver o ambiente).

Em qualquer caso, comparar com a tabela "Escala" da arquitetura e atualizá-la com a data, o tamanho da instância e o commit.
