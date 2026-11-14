# Roteiro do Supabase de verdade (T23)

Roda **à mão e nunca no CI**: usa o projeto do Supabase hospedado e a chave de serviço (segredo). Cobre, no navegador e no
Supabase real, os critérios de [[Conta e login]] **4, 6, 7, 26 e 27**. O login com o Google e a caixa de e-mail de verdade
continuam no roteiro manual da A11 do plano de login.

## O que ele faz
1. Cria um banco local `futbolsa_e2e_supabase` (nunca o do Supabase) e o apaga no fim.
2. Constrói o site normal (login real, **sem** o adaptador falso) em `apps/web/out-supabase/`.
3. Sobe a API de verdade (`dist/main.js`) ligada ao Supabase real, e um servidor estático para o site.
4. Cria uma conta de teste pela chave de serviço (`auth.admin.createUser`, e-mail já confirmado), roda o Playwright e **apaga a
   conta no fim**, mesmo se um teste falhar. O link de nova senha vem do `auth.admin.generateLink`, no lugar do e-mail; nenhum
   e-mail é enviado.
5. Sem vídeo, rastro nem captura: telas de login e links de nova senha não viram arquivo.

## Como rodar
No terminal, **na hora de rodar** (nada disso fica em arquivo commitado nem no histórico do Claude):

```bash
export TEST_DATABASE_URL=postgres://postgres:<senha>@localhost:5432/postgres
export SUPABASE_URL=https://<projeto>.supabase.co
export SUPABASE_PUBLISHABLE_KEY=<chave pública>
export SUPABASE_SERVICE_ROLE_KEY=<chave de serviço>
npm run e2e:supabase -w @futbolsa/web
```

O Docker pode ficar desligado. Precisa do Chromium do Playwright (`npx playwright install chromium`, uns 300 MB).

## O que cada teste confere
| Teste | Critério | Como |
|---|---|---|
| `e2e conta 4` | 4 | no formulário de primeiro acesso, 7 caracteres travam o botão e 8 liberam (não envia: mandaria e-mail de verdade) |
| `e2e conta 6` | 6 | senha errada e e-mail sem conta dão a mesma mensagem no Supabase real |
| `e2e conta 7` | 7 | o link de nova senha (do `generateLink`) leva à tela, grava a senha nova, e a antiga é recusada |
| `e2e conta 26` | 26 | trocar a senha logado grava a nova e recusa a de 7 caracteres; a nova entra |
| `e2e conta 27` | 27 | quem entra sem senha (link mágico, como o Google) cria a senha na tela da conta e passa a entrar por e-mail |

## O que **não** cobre (conferir à mão uma vez)
- **Critério 26, "sair do outro aparelho"** e "pedir o login de novo com o último login há 2 horas": o token de acesso do
  Supabase vale 1 hora e o teste não viaja no tempo. Conferir à mão: entrar no computador e no celular, trocar a senha no
  computador e ver o celular pedir login quando o token vencer.
- **Google** (critérios 2 e 3 pelo Google, 20 e a primeira entrada) e o **e-mail que chega** de verdade: roteiro manual da A11.
- Criar a conta pelo formulário de primeiro acesso, de ponta a ponta: manda e-mail real (limite do plano grátis). Use
  `npm run mail:check -w @futbolsa/api` e o roteiro manual.

## Se falhar
- `Faltam variáveis de ambiente`: o script diz quais, sem mostrar valores.
- `não criei a conta de teste`: a chave de serviço ou a URL estão erradas, ou o limite de contas do plano foi atingido.
- Se o script morrer no meio e sobrar uma conta `futbolsa-e2e-…@example.com` no painel (Authentication > Users), apague-a.
