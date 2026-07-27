# Deploy — substituir o site do controle-de-projetos pelo Hub P&C

Passo a passo completo. Ordem importa: **Supabase primeiro**, Netlify depois.
Se inverter, o hub sobe no ar sem allowlist e ninguém consegue entrar (ou pior,
o `app_state` fica fechado antes de existir quem possa lê-lo).

Projeto Supabase: `hjducsxcolbspbkpflom` (o mesmo do controle-de-projetos —
o hub absorve, não cria projeto novo agora).

---

## Parte 1 — Supabase

### 1.1 Rodar o schema

Painel → **SQL Editor** → New query → colar o conteúdo de
[`sql/hub_schema.sql`](../sql/hub_schema.sql) → **Run**.

Cria: `allowed_users`, `user_dashboard_access`, os helpers
(`hub_email`, `hub_is_admin`, `hub_is_allowed`, `hub_can`), o bucket privado
`hub-data` com a policy de leitura por dashboard, e `access_log`.

> O bloco 6 do arquivo (fechar o `app_state` na allowlist) está **comentado**
> de propósito. Ele é o passo 1.5, mais abaixo.

Conferir: **Table Editor** deve mostrar `allowed_users`, `user_dashboard_access`
e `access_log`. **Storage** deve mostrar o bucket `hub-data` como *Private*.

### 1.2 Semear a allowlist

SQL Editor → colar o conteúdo de `sql/seed_allowlist.local.sql`
(está na sua máquina, gitignorado — os e-mails não vão pro Git) → **Run**.

São os 9 e-mails. `usuario1@exemplo.com` entra como `admin` (vê tudo,
sem precisar de linha em `user_dashboard_access`). Os outros 8 entram como
`user` com Projetos + Indicadores + DRE liberados.

A última query do arquivo já devolve a conferência:

```text
email                              role   ativo  dashboards
usuario1@exemplo.com        admin  true   {}
usuario2@exemplo.com                 user   true   {dre,indicadores,projetos}
...
```

`{}` no admin está certo — ele não usa a tabela de permissão.

### 1.3 Desligar signup público

**Authentication → Sign In / Providers → Email**:

- `Enable Email provider`: **ligado**
- `Confirm email`: **ligado**
- **`Allow new users to sign up`: DESLIGADO** ← esse é o que fecha a porta

O front já manda `shouldCreateUser: false`, então o magic-link nunca cria conta.
Consequência: o e-mail precisa existir em `auth.users` antes do primeiro login.

**Authentication → Users → Add user → Send invitation** — convidar os 9.
Quem já entrou no controle-de-projetos alguma vez já está lá; confira a lista
antes de convidar de novo.

Conferir quem falta:

```sql
select u.email, (a.id is not null) as tem_conta
  from allowed_users u
  left join auth.users a on lower(a.email) = u.email
 order by 2, 1;
```

### 1.4 URLs de redirect

**Authentication → URL Configuration**:

- `Site URL`: `https://SEU-SITE.netlify.app` (a URL final, com barra no fim se
  o painel aceitar)
- `Redirect URLs`: adicionar
  - `https://SEU-SITE.netlify.app/**`
  - `http://localhost:5178/**` (pra testar local)
  - a URL do deploy preview, se for testar por lá:
    `https://deploy-preview-*--SEU-SITE.netlify.app/**`

O magic-link usa PKCE e volta em `/?code=...`, então basta a raiz estar liberada.

### 1.5 Fechar o Projetos na allowlist — **só depois do 1.2**

Hoje o `app_state` (dado do Projetos) aceita qualquer `@luxor.com.br`
autenticado. Pra passar pra allowlist, SQL Editor:

```sql
drop policy if exists "luxor_select" on app_state;
create policy hub_projetos_select on app_state
  for select to authenticated using ( public.hub_can('projetos') );

drop policy if exists "luxor_update" on app_state;
create policy hub_projetos_update on app_state
  for update to authenticated
  using ( public.hub_can('projetos') ) with check ( public.hub_can('projetos') );
```

(É o bloco 6 do `hub_schema.sql`, descomentado.)

Se algo der errado, o rollback é voltar a policy antiga:

```sql
drop policy if exists hub_projetos_select on app_state;
create policy "luxor_select" on app_state for select to authenticated
  using ( (auth.jwt() ->> 'email') like '%@luxor.com.br' );
drop policy if exists hub_projetos_update on app_state;
create policy "luxor_update" on app_state for update to authenticated
  using      ( (auth.jwt() ->> 'email') like '%@luxor.com.br' )
  with check ( (auth.jwt() ->> 'email') like '%@luxor.com.br' );
```

### 1.6 Publicar os dados

Na raiz do repo, criar `.env` (gitignorado):

```ini
SUPABASE_URL=https://hjducsxcolbspbkpflom.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<Project Settings > API > service_role>
```

A service_role ignora RLS. Nunca no front, nunca no Git, nunca no Netlify.

```bash
python tools/build_data.py     # lê Azure + Drive -> assets/data/*.json e *.js
python tools/publish_hub.py    # sobe os .json pro bucket hub-data
```

Conferir em **Storage → hub-data**: `indicadores.json` e `dre.json`.

---

## Parte 2 — Netlify

### 2.1 Trocar o repo do site (mantém a URL)

Site atual (o do controle-de-projetos) → **Site configuration → Build & deploy
→ Continuous deployment → Repository → Manage repository → Link to a different
repository** → escolher `Luxor-Planejamento-e-Controle/LuxorP-CHub`.

- Branch to deploy: `main`
- Build command: **vazio**
- Publish directory: `.`

(Já está no `netlify.toml`, mas confira que o painel não sobrescreveu.)

O Netlify precisa de acesso ao repo — `LuxorP-CHub` é **privado**, então
autorize a org `Luxor-Planejamento-e-Controle` no app do Netlify no GitHub.

> Alternativa mais segura, se quiser testar antes sem mexer no site vivo:
> criar um site novo apontando pro `LuxorP-CHub`, validar tudo lá, e só então
> trocar o domínio/URL. Custa um passo a mais e evita janela de site quebrado.

### 2.2 Deploy preview

Abrir a URL do deploy. Esperado:

1. Tela de login Luxor (fundo escuro, logo, campo de e-mail).
2. E-mail fora da allowlist → *"Seu e-mail não está liberado no hub."*
3. E-mail da lista → link no e-mail → volta logado, sidebar com Início,
   Indicadores, DRE, Projetos. **Sem Inadimplência** (staged, correto).
4. Aba Projetos → carrega **sem pedir login de novo** (mesma sessão, mesmo origin).
5. Editar um projeto → salva → abrir em outro navegador logado → realtime atualiza.
6. Indicadores e DRE → gráficos com dado (vieram do bucket privado).
7. Abrir `https://SEU-SITE/assets/data/indicadores.js` → **404**. Se der 200,
   parou o deploy: dado financeiro estático exposto.
8. Abrir `https://SEU-SITE/dashboard-projetos.html` → redireciona pra
   `#/projetos` (bookmark antigo).

### 2.3 Promover

Só depois de 1–8 passarem. `Deploys → Publish deploy`.

---

## Depois

- Rotina de atualização: `build_data.py` + `publish_hub.py`. O hub não precisa
  de novo deploy pra dado novo — só o bucket muda.
- Painel de administração (admin gerindo allowlist pela UI, sem SQL) é a próxima
  fase. Hoje é `insert` no `allowed_users` / `user_dashboard_access`.
- Inadimplência continua fora até o desenho da seção 5 da
  [ARQUITETURA.md](ARQUITETURA.md) (PII, RLS por linha, auditoria).

## Se der ruim

| Sintoma | Causa provável |
| --- | --- |
| Login manda o e-mail mas o link cai em `localhost` | `Site URL` errado no Supabase (1.4) |
| Link do e-mail dá "invalid request" | URL não está em `Redirect URLs` (1.4) |
| Loga e diz "não está liberado" | e-mail fora de `allowed_users`, ou `ativo=false` (1.2) |
| Entra mas nav só tem Início | sem linhas em `user_dashboard_access` (1.2) |
| Indicadores/DRE vazios | snapshot não subiu (1.6) ou policy do bucket (1.1) |
| Projetos pede login dentro do iframe | sessão não compartilhada — conferir que o iframe é mesmo origin (`/assets/projetos/index.html`, não CDN/outro domínio) |
| Projetos abre mas não salva | policy do `app_state` (1.5) — usuário sem `hub_can('projetos')` |
