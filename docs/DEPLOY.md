# Deploy — substituir o site do controle-de-projetos pelo Hub P&C

Guia clique a clique. Tempo total: ~40 min, quase tudo esperando e-mail chegar.

**Ordem importa.** Supabase primeiro, Netlify depois. Se inverter, o hub sobe no
ar sem allowlist, ou o `app_state` fica fechado antes de existir quem possa lê-lo
e o Projetos para pra todo mundo.

## Antes de começar, tenha em mãos

| Coisa | Onde acha |
| --- | --- |
| Projeto Supabase | `hjducsxcolbspbkpflom` — [dashboard](https://supabase.com/dashboard/project/hjducsxcolbspbkpflom) |
| Site no Netlify | `lxplanejamentoecontrole` — <https://lxplanejamentoecontrole.netlify.app/> (hoje serve o controle-de-projetos) |
| Repo | `Luxor-Planejamento-e-Controle/LuxorP-CHub` |
| Terminal | aberto em `C:\Users\Arthur\repos\LuxorP&CHub` |

Ordem das partes:

- **Parte 0** — abrir o repo (5 min)
- **Parte 1** — Supabase: schema, allowlist, convites, URLs, dados (20 min)
- **Parte 2** — Netlify: trocar o repo, testar, promover (15 min)
- **Parte 3** — fechar o Projetos na allowlist (2 min, só depois de tudo funcionando)

---

## Parte 0 — Tornar o repo público

### Por que

O plano gratuito do Netlify não faz deploy contínuo de repositório **privado de
organização**. Como o hub vive na org `Luxor-Planejamento-e-Controle`, ou o repo
vira público, ou o plano vira pago.

É seguro aqui porque só a casca do site está versionada. Dado real, e-mails da
allowlist e segredos vivem no Supabase. O histórico foi auditado: nunca entrou
`.env`, `assets/data/`, `assets/inadimplencia/` nem seed com e-mail real, e o
único JWT em todos os commits é a anon key — pública por design.

### 0.1 Instalar o hook de proteção

No terminal, na raiz do repo:

```bash
python tools/install_hooks.py
```

Saída esperada:

```text
core.hooksPath = .githooks
hooks ativos: pre-commit
```

Isso liga um `pre-commit` que recusa commit contendo dado real, PII, e-mail
`@luxor.com.br`, `service_role` JWT ou chave privada. **Rodar em todo clone**
que for commitar (o hook não vem junto no `git clone`).

Testar que está mesmo ativo:

```bash
git add -f sql/seed_allowlist.local.sql
git commit -m teste
```

Tem que barrar:

```text
pre-commit: seed com dado real: sql/seed_allowlist.local.sql
pre-commit: e-mail real em sql/seed_allowlist.local.sql: 5:  ('<nome>@lux...
Commit barrado. Repo é público — tire o arquivo do stage ...
```

Desfazer o teste:

```bash
git restore --staged sql/seed_allowlist.local.sql
```

Se **não** barrou, o hook não está ativo. Confira `git config core.hooksPath`
(tem que devolver `.githooks`).

### 0.2 Última conferência antes de abrir

```bash
git status --short
git check-ignore -v .env assets/data assets/inadimplencia sql/seed_allowlist.local.sql
```

O segundo comando tem que listar os quatro como ignorados. Se algum não
aparecer, **pare** e resolva antes de tornar público.

### 0.3 Abrir o repo

1. github.com → `Luxor-Planejamento-e-Controle/LuxorP-CHub`
2. **Settings** (aba no topo do repo, não a do seu perfil)
3. Rolar até o fim → seção **Danger Zone**
4. **Change repository visibility** → **Change to public**
5. Confirmar digitando o nome do repo
6. Marcar a confirmação de que entende que o código fica visível

### 0.4 Conferir com olhos de estranho

Abrir **janela anônima** (Ctrl+Shift+N) e ir em
`https://github.com/Luxor-Planejamento-e-Controle/LuxorP-CHub`.

Confirmar que **não** aparece:

- [ ] `.env`
- [ ] pasta `assets/data/`
- [ ] pasta `assets/inadimplencia/`
- [ ] `sql/seed_allowlist.local.sql`
- [ ] qualquer `.xlsx`, `.csv`, `.parquet`, `.pbix`

Se algum apareceu: repo de volta pra privado **agora**, me chama, e trate os
segredos como vazados (rotacionar).

> Daqui pra frente, repo público + anon key pública = qualquer um alcança a API
> do seu Supabase. É o modelo esperado: quem protege é a RLS, não o sigilo da
> URL. Por isso a Parte 1 não tem passo opcional.

---

## Parte 1 — Supabase

Tudo em [supabase.com/dashboard/project/hjducsxcolbspbkpflom](https://supabase.com/dashboard/project/hjducsxcolbspbkpflom).

### 1.1 Rodar o schema

1. Menu lateral esquerdo → **SQL Editor**
2. **+ New query** (canto superior esquerdo do painel)
3. Abrir [`sql/hub_schema.sql`](../sql/hub_schema.sql) no VS Code, **Ctrl+A**,
   **Ctrl+C**
4. Colar na query
5. **Run** (ou **Ctrl+Enter**)

Esperado: `Success. No rows returned`.

Se der erro em `insert into storage.buckets`, o bucket já existe de tentativa
anterior — pode seguir, o `on conflict` cobre.

**Conferir:**

- Menu **Table Editor** → devem existir `allowed_users`,
  `user_dashboard_access`, `access_log`
- Menu **Storage** → deve existir o bucket **`hub-data`**, marcado **Private**
  (se aparecer *Public*, algo falhou — rode de novo o bloco 5 do arquivo)

Conferência por SQL, se preferir:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('allowed_users','user_dashboard_access','access_log');

select id, public from storage.buckets where id = 'hub-data';
```

O segundo tem que devolver `hub-data | false`.

### 1.2 Semear a allowlist

1. SQL Editor → **+ New query**
2. Abrir `sql/seed_allowlist.local.sql` no VS Code (está na sua máquina,
   gitignorado — os e-mails não vão pro Git), copiar tudo
3. Colar e **Run**

São os e-mails da lista. O seu entra como `admin`; os demais como `user`,
com Projetos + Indicadores + DRE liberados.

A última query do arquivo já devolve a conferência:

```text
email                       role   ativo  dashboards
<voce>@luxor.com.br         admin  t      {}
<pessoa1>@luxor.com.br      user   t      {dre,indicadores,projetos}
<pessoa2>@luxor.com.br      user   t      {dre,indicadores,projetos}
...
```

**`{}` no admin está certo.** Admin não usa `user_dashboard_access` — a função
`hub_is_admin()` libera tudo.

**Checkpoint:** uma linha por e-mail do seed, exatamente 1 com `role = admin`.
Se vier menos, faltou e-mail no insert.

### 1.3 Fechar o cadastro e convidar a lista

#### Desligar signup público

1. Menu **Authentication**
2. Submenu **Sign In / Providers** (em versões antigas: **Providers**)
3. Clicar em **Email**
4. Conferir/ajustar:
   - `Enable Email provider` — **ligado**
   - `Confirm email` — **ligado**
   - **`Allow new users to sign up` — DESLIGADO** ← é este que fecha a porta
5. **Save**

O front também manda `shouldCreateUser: false`, então o magic-link nunca cria
conta. Os dois juntos: cinto e suspensório.

#### Consequência: o e-mail precisa existir antes

Sem signup, `signInWithOtp` só funciona pra quem já está em `auth.users`.
Ver quem falta:

```sql
select u.email, (a.id is not null) as tem_conta
  from allowed_users u
  left join auth.users a on lower(a.email) = u.email
 order by tem_conta, u.email;
```

Quem já usou o controle-de-projetos alguma vez aparece com `tem_conta = true`.

#### Convidar quem tem `tem_conta = false`

1. **Authentication** → **Users**
2. Botão **Add user** (canto superior direito) → **Send invitation**
3. Digitar o e-mail → **Send invitation**
4. Repetir pra cada um

O convidado recebe um e-mail de convite. Ele pode clicar ali, ou ignorar e
depois pedir o magic-link direto no hub — o que importa é a conta existir.

**Checkpoint:** rodar a query de novo, todos com `tem_conta = true`.

### 1.3b SMTP próprio — obrigatório

O serviço de e-mail embutido do Supabase é **só pra desenvolvimento**:
**2 e-mails por hora no projeto inteiro**, e a própria Supabase avisa que não
tem garantia de entrega. Com 8 pessoas entrando, isso trava no primeiro dia:

```json
{"code":429,"error_code":"over_email_send_rate_limit","msg":"email rate limit exceeded"}
```

O erro aparece no **Console do navegador (F12)** — a tela mostra a mensagem
genérica de propósito.

**Project Settings** → **Authentication** → seção **SMTP Settings** →
**Enable Custom SMTP**. Preencher host, porta, usuário, senha, e o remetente
(`Sender email` / `Sender name`).

Opções, da mais simples pra mais robusta:

| Serviço | Host / porta | Observação |
| --- | --- | --- |
| Microsoft 365 | `smtp.office365.com` : 587 | Já é o e-mail da Luxor. Precisa de uma conta de envio e senha de app / SMTP AUTH habilitado no tenant |
| Google Workspace | `smtp.gmail.com` : 587 | Idem, com senha de app |
| Resend | `smtp.resend.com` : 587 | Grátis até 3k/mês, 5 min pra configurar, exige verificar o domínio |
| Brevo / SendGrid | ver painel do serviço | Equivalentes |

Se usar SMTP do próprio domínio, o remetente tem que ser um endereço real de
`@luxor.com.br` — senão SPF/DKIM reprovam e cai em spam.

Depois de ligar o SMTP: **Authentication** → **Rate Limits** → subir
`Rate limit for sending emails` (o padrão baixo existe por causa do SMTP
embutido; com SMTP próprio pode subir).

**Testar:** pedir o link no hub e ver se chega. Se ainda der 429, esperou menos
de 1h desde o último estouro — o contador é por hora.

#### Escape hatch: entrar sem e-mail

Enquanto o SMTP não está de pé (ou se ele cair depois), dá pra gerar o link
direto pela Admin API:

```bash
python tools/login_link.py <seu-email>@luxor.com.br
```

Imprime um link de **uso único**, válido ~1h. Abrir no navegador e pronto,
está logado. Precisa do `.env` com a `service_role` (passo 1.5).

Tratar o link como senha: quem tiver ele entra como aquela pessoa. Não mandar
por grupo de WhatsApp nem colar em chat.

### 1.4 URLs de redirect

Sem isso o link do e-mail cai em `localhost` ou dá "invalid request".

1. **Authentication** → **URL Configuration**
2. **Site URL**: `https://lxplanejamentoecontrole.netlify.app`
3. **Redirect URLs** → **Add URL**, uma por vez:
   - `https://lxplanejamentoecontrole.netlify.app/**`
   - `http://localhost:5178/**` — pra testar na sua máquina
   - `https://deploy-preview-*--lxplanejamentoecontrole.netlify.app/**` — se for testar no
     preview antes de promover
4. **Save**

O `/**` no fim é curinga: cobre qualquer caminho do site.
O magic-link usa PKCE e volta em `/?code=...`, então basta a raiz estar liberada.

### 1.5 Publicar os snapshots de dado

#### Criar o `.env`

Na raiz do repo, arquivo `.env` (já está no `.gitignore`):

```ini
SUPABASE_URL=https://hjducsxcolbspbkpflom.supabase.co
SUPABASE_SERVICE_ROLE_KEY=cole_aqui
```

A `service_role`: **Project Settings** (engrenagem no rodapé do menu) →
**API Keys** → aba **Legacy API keys** → linha `service_role` → **Reveal** →
copiar. (Em projetos mais novos: **API Keys** → **Secret keys**, chave
`sb_secret_...`. Qualquer uma serve.)

> Essa chave **ignora RLS por completo** — lê e escreve qualquer tabela do
> projeto, allowlist inclusive. Só no `.env` local. Nunca no `config.js`, nunca
> em variável do Netlify, nunca em print ou chat.

#### Gerar e subir

```bash
python tools/build_data.py
python tools/publish_hub.py
```

`build_data.py` lê o Azure (indicadores) e o `DRE_Historico.xlsx` no Drive G:,
e grava `assets/data/*.json` + `*.js`. Precisa do Drive montado e do `.env` do
`FinancialIndicators`.

> Se só quiser publicar o que já está gerado (dado de 23/07), pule o
> `build_data.py`. Pra dado fresco, rode os dois.

Saída esperada do publish:

```text
[ok] indicadores.json (1317 KB) -> hub-data/indicadores.json
[ok] dre.json (3746 KB) -> hub-data/dre.json
```

**Conferir:** menu **Storage** → bucket **hub-data** → os dois arquivos lá,
com a data de hoje.

Se der `HTTP 400`/`403`: chave errada, ou o bucket não existe (volte ao 1.1).

---

## Parte 2 — Netlify

### 2.1 Decidir o caminho

**Caminho A — trocar o site existente.** Mantém a URL na hora. Se der ruim, o
site fica quebrado até você reverter.

**Caminho B — site novo, trocar a URL depois.** Um passo a mais, zero janela de
site quebrado. **É o que eu recomendo.**

#### Caminho B (recomendado)

1. app.netlify.com → **Add new site** → **Import an existing project**
2. **Deploy with GitHub** → autorizar se pedir
3. Escolher `Luxor-Planejamento-e-Controle/LuxorP-CHub`
4. Branch `main`, **Build command vazio**, **Publish directory `.`**
5. **Deploy site**
6. Anotar a URL provisória (`algo-aleatorio.netlify.app`)
7. Voltar ao **1.4** e adicionar essa URL provisória nos `Redirect URLs`
   (senão o login não fecha o ciclo no teste)
8. Testar tudo da **2.3**
9. Passando: no site **antigo**, Domain management → remover o domínio;
   no site **novo**, adicionar. Ou simplesmente aposentar o antigo e divulgar
   a URL nova.

#### Caminho A

1. app.netlify.com → o site atual
2. **Site configuration** → **Build & deploy** → **Continuous deployment**
3. Seção **Repository** → **Manage repository** → **Link to a different repository**
4. Escolher `Luxor-Planejamento-e-Controle/LuxorP-CHub`
5. Branch `main`, build command **vazio**, publish directory `.`
6. **Save** → dispara deploy

### 2.2 Se o repo não aparece na lista

Não é o `netlify.toml` — é permissão do GitHub:

GitHub → seu avatar → **Settings** → **Applications** → **Authorized OAuth Apps**
(ou **Installed GitHub Apps**) → **Netlify** → em **Organization access**,
**Grant** pra `Luxor-Planejamento-e-Controle`.

Se a org exigir aprovação de owner e você não for owner, peça a quem é.

### 2.3 Checklist de teste — não pule nenhum

Abrir a URL do deploy. Marcar um por um:

- [ ] **1.** Aparece a tela de login: fundo escuro, logo Luxor, campo de e-mail.
      A casca do hub **não** aparece por trás.
- [ ] **2.** Digitar um e-mail que **não** está na lista (ex.: seu Gmail).
      Resposta: *"Se este e-mail estiver liberado, o link de acesso chegou na
      caixa de entrada."* e **nenhum e-mail chega**.
      A resposta é igual pra liberado e não liberado **de propósito** — site
      público não pode virar oráculo pra descobrir quem tem conta na Luxor.
- [ ] **3.** Digitar o **seu** e-mail (o admin) → clicar no link do e-mail →
      volta logado. Sidebar com **Início, Indicadores, DRE, Projetos**.
      **Sem Inadimplência** — correto, está `staged`.
- [ ] **4.** Topo direito mostra seu nome e o botão **Sair**.
- [ ] **5.** Aba **Indicadores** → gráfico com dado, seletor de índice funcionando.
      (Veio do bucket privado, não de arquivo estático.)
- [ ] **6.** Aba **DRE** → barras Orçado × Realizado, filtros Modelo/CC/Natureza.
- [ ] **7.** Aba **Projetos** → carrega **sem pedir login de novo**.
      Se pedir, a sessão não está sendo compartilhada — me chama.
- [ ] **8.** Editar um projeto → salva. Abrir em outro navegador logado →
      o realtime atualiza sozinho.
- [ ] **9.** **O teste que mais importa:** abrir
      `https://lxplanejamentoecontrole.netlify.app/assets/data/indicadores.js` →
      tem que dar **404**.
      **Se der 200, pare tudo** — dado financeiro estático exposto na internet.
- [ ] **10.** `https://lxplanejamentoecontrole.netlify.app/dashboard-projetos.html` →
      redireciona pra `#/projetos` (bookmark antigo de quem já usava).
- [ ] **11.** Sair → volta pra tela de login, não pro hub.
- [ ] **12.** Testar com **um usuário comum** (não admin), de outra conta:
      entra e vê as mesmas abas, sem Inadimplência.

### 2.4 Promover

Só com 1–12 passando.

- Caminho A: **Deploys** → o deploy mais recente → **Publish deploy**
- Caminho B: mover o domínio conforme 2.1

---

## Parte 3 — Fechar o Projetos na allowlist

**Só depois do checklist inteiro passando.** Hoje o `app_state` (dado do
Projetos) aceita qualquer `@luxor.com.br` autenticado. Isto troca pra allowlist:

SQL Editor → **+ New query**:

```sql
drop policy if exists "luxor_select" on app_state;
create policy hub_projetos_select on app_state
  for select to authenticated using ( public.hub_can('projetos') );

drop policy if exists "luxor_update" on app_state;
create policy hub_projetos_update on app_state
  for update to authenticated
  using ( public.hub_can('projetos') ) with check ( public.hub_can('projetos') );
```

(É o bloco 6 do [`hub_schema.sql`](../sql/hub_schema.sql), descomentado.)

**Testar logo depois:** abrir o hub, aba Projetos, editar e salvar. Se salvar,
funcionou. Se der erro de permissão, rollback:

```sql
drop policy if exists hub_projetos_select on app_state;
create policy "luxor_select" on app_state for select to authenticated
  using ( (auth.jwt() ->> 'email') like '%@luxor.com.br' );

drop policy if exists hub_projetos_update on app_state;
create policy "luxor_update" on app_state for update to authenticated
  using      ( (auth.jwt() ->> 'email') like '%@luxor.com.br' )
  with check ( (auth.jwt() ->> 'email') like '%@luxor.com.br' );
```

Causa mais provável do erro: usuário sem a linha `projetos` em
`user_dashboard_access` (volte ao 1.2).

---

## Rotina depois de no ar

### Atualizar dado

```bash
python tools/build_data.py
python tools/publish_hub.py
```

**Não precisa de deploy novo.** O site é a casca; o dado vem do bucket. Quem
recarregar a página já pega o novo.

### Liberar um usuário

```sql
insert into allowed_users (email, nome, role)
  values ('novo@luxor.com.br', 'Nome', 'user')
  on conflict (email) do update set ativo = true;

insert into user_dashboard_access (email, dashboard) values
  ('novo@luxor.com.br', 'projetos'),
  ('novo@luxor.com.br', 'indicadores'),
  ('novo@luxor.com.br', 'dre')
on conflict do nothing;
```

Depois: **Authentication → Users → Add user → Send invitation**.

### Revogar

```sql
update allowed_users set ativo = false where email = 'saiu@luxor.com.br';
```

Corta na hora todos os dashboards e o bucket. A sessão aberta que ele já tem
continua válida até expirar — pra cortar já, **Authentication → Users** →
o usuário → **Delete user**.

### Tirar um dashboard de alguém

```sql
delete from user_dashboard_access
 where email = 'alguem@luxor.com.br' and dashboard = 'dre';
```

### Quem entrou onde

```sql
select email, dashboard, at from access_log order by at desc limit 50;
```

---

## Se der ruim

| Sintoma | Causa provável |
| --- | --- |
| Diz que enviou mas o e-mail não chega | (a) e-mail sem conta em `auth.users` — falta o convite (1.3); (b) rate limit do SMTP embutido — ver 1.3b. F12 → Console mostra qual |
| Console mostra `429 over_email_send_rate_limit` | SMTP embutido estourou (2/h no projeto). Configurar SMTP próprio (1.3b) ou usar `tools/login_link.py` |
| Link do e-mail cai em `localhost` | `Site URL` errado (1.4) |
| Link dá "invalid request" / "otp_expired" | URL fora dos `Redirect URLs` (1.4), ou link já usado — magic-link é de uso único |
| Loga e diz "não está liberado" | e-mail fora de `allowed_users`, ou `ativo = false` (1.2) |
| Entra mas a nav só tem Início | sem linhas em `user_dashboard_access` (1.2) |
| Indicadores/DRE vazios | snapshot não subiu (1.5) ou policy do bucket (1.1) |
| Projetos pede login dentro do iframe | sessão não compartilhada — o iframe tem que ser mesmo origin (`/assets/projetos/index.html`) |
| Projetos abre mas não salva | policy do `app_state` (Parte 3) — usuário sem `hub_can('projetos')` |
| Tela branca | F12 → Console. Quase sempre `config.js` não carregou ou o Supabase está fora |
| `/assets/data/*.js` devolve 200 | **grave** — arquivo entrou no repo. Tirar, refazer deploy, e como o repo é público, tratar o dado como exposto |

### Rollback total

Netlify → **Deploys** → achar o último deploy do controle-de-projetos →
**Publish deploy**. Volta o site antigo no ar em segundos.

O Supabase não precisa reverter: as tabelas novas não atrapalham o app antigo.
Só desfaça a **Parte 3** se já tiver rodado (o rollback está lá em cima).
