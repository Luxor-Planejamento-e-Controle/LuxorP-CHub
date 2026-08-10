# Arquitetura — Luxor P&C Hub

Hub web de dashboards do Planejamento & Controle. Guarda-chuva que reúne, num
único site com login e tema Luxor, os relatórios hoje espalhados em vários
`.pbix` e num app avulso (controle-de-projetos).

Status: **MVP em produção**. Front estático (sem build ainda), auth por
magic-link + allowlist + RBAC na casca (`assets/auth.js` + `sql/hub_schema.sql`),
Indicadores e DRE lendo snapshots do bucket privado `hub-data`, e o
`controle-de-projetos` absorvido em `assets/projetos/` (mesmo Supabase, sessão
compartilhada). Inadimplência fora do ar até o desenho da seção 5. O restante
segue o desenho abaixo.

---

## 1. O que o hub vai conter

Cada "assunto" vira uma página/seção do hub. Origem de dados de cada um:

| Seção | ETL / fonte do código | Saída hoje | Sensibilidade |
|-------|-----------------------|-----------|---------------|
| **Indicadores Financeiros** | `FinancialIndicators` (Container App Job) | Azure Blob `azblobstoragebz` / container `luxor-planejamento-e-controle` (xlsx) | interno, agregado |
| ↳ ticker **Resultado FO** | `LuxorMonthlyFORoutines` → `group_returns_report_builder.py` | mesmo container, `LuxorControlDatabase/parquet/group_hist_data.parquet` (`Segment == Resultado_FO`) | financeiro interno |
| **DRE — Orçado × Realizado / YTD** | `LuxorMonthlyP-CRoutines` → `DRE Data/LxDREdataExtractor.py` | Google Drive `DRE_Historico.xlsx` | financeiro interno |
| **Fluxo de Caixa** | `LuxorMonthlyP-CRoutines` → `FCDataExtractor` | Google Drive (parquet/xlsx) | financeiro interno |
| **Participações** | `LuxorMonthlyP-CRoutines` → `PBI Luxor participações` | Google Drive | financeiro interno |
| **Plantel / Vendas HPG** | `LuxorMonthlyP-CRoutines` → `PlantelHPG` + `Controle de vendas HPG` | Google Drive | interno |
| **Inadimplência** | `controle-de-inadimplencia` → `ControleInadimplencia.py` | Google Drive `output_pbi/*.xlsx` | **PII / LGPD** |
| **Projetos** | `controle-de-projetos` (já é web) | Supabase | interno |

Observação central: as bases vivem em **dois lugares** — Google Drive (maioria
dos ETLs P&C) e Azure Blob (indicadores) — e **um dataset tem dado pessoal**
(inadimplência: `nome_pessoa`, valores, títulos). O navegador não lê nenhuma
dessas fontes direto. Isso define a arquitetura abaixo.

---

## 2. Visão geral (3 planos)

```
  [ ETLs Python ]          [ Plano de dados ]            [ Web / Hub ]
  main.py (P&C)            Supabase Postgres+Storage     SPA (Vite)
  FinancialIndicators  →   (não-PII: snapshots)      →   ECharts
  ControleInadimplencia    (PII: tabelas + RLS)          Netlify
        │                        ▲                            │
        └── passo "publish" ─────┘        auth @luxor.com.br ─┘
```

1. **Plano de ingestão** — os ETLs que já existem, sem reescrever a lógica.
   Ganham só um **passo de publish** no fim.
2. **Plano de dados** — Supabase como fonte única do hub (Postgres + Storage +
   Auth + RLS + Edge Functions). Único ponto de autenticação e autorização.
3. **Plano de apresentação** — SPA que lê o plano de dados com o usuário logado.
   Nunca fala com Drive/Blob direto.

Por que Supabase como plano único (e não o browser lendo Blob/Drive):
- Um só lugar de auth + RBAC + RLS, reaproveitando o que o controle-de-projetos
  já provou (magic-link `@luxor.com.br`).
- PII **não pode** ser servida como arquivo estático; precisa de banco com
  política de linha/coluna. Ter tudo num plano só evita dois modelos de segurança.
- Snapshots já prontos p/ gráfico = fetch rápido, sem processar parquet no client.

---

## 3. O ciclo "rodar código → dashboard atualiza"

Meta do time: atualizar a base e ver o dashboard novo **sem passo manual extra**.

Hoje o fluxo termina no xlsx/parquet que o Power BI abre. Adicionamos **um
publisher** que lê a saída do ETL e grava no plano de dados:

- **Não-PII** (indicadores, DRE, fluxo, participações, plantel):
  `publish_hub.py` lê a saída do ETL (Drive/Blob), transforma nas séries que o
  gráfico precisa e faz **upsert** numa tabela Postgres (ou grava JSON num
  bucket privado do Storage). Chave por dataset + data de referência.
- **PII** (inadimplência): o publisher carrega as linhas em tabelas Postgres
  **segregadas, com RLS** (detalhe na seção 5). Nunca em JSON público.

Dois scripts (decidido):

- **`run_all_etls`** — roda todos os ETLs. Ao terminar, **pergunta se dispara o
  `publish_dash` automaticamente**. Orquestra os ETLs que hoje vivem em 3 repos:
  `LuxorMonthlyP-CRoutines` (DRE, FCF, FC, Participações, Plantel, Vendas),
  `FinancialIndicators` (indicadores) e `controle-de-inadimplencia`.
- **`publish_dash`** — lê as saídas dos ETLs (Drive/Blob/`output_pbi`),
  transforma nas séries prontas pro gráfico e faz **upsert** no Supabase.
  Pode rodar sozinho, sem re-rodar os ETLs (re-publicar quando quiser).

**Já implementado — fatia "indicadores"**: `tools/run_etl_indicadores.py` roda, na
ordem, `FinancialIndicators/Scripts/azure_monthly_pipeline.py` (modo Blob),
o `cvm.py` das cotas, `build_data.py indicadores` e `publish_hub.py indicadores`.
A ordem é obrigatória: o `cvm.py` monta a cota USD com o dólar que lê do
`Indicadores_financeiros.xlsx` do Drive. O **Resultado FO** (`group_hist_data`,
pipeline do FO) fica fora de propósito — fechamento ainda provisório, roda à parte.
No modo Blob o Blob é a cópia autoritativa e o xlsx/parquet do Drive é espelho
(pull antes de calcular, push depois).

Uso normal = rodar `run_all_etls` e responder "sim" pra atualizar os dashboards
num fluxo só. Agendado: Container App Job / GitHub Action roda os dois em
sequência (padrão que o `FinancialIndicators` já usa hoje) — diário p/
indicadores, mensal p/ DRE/inadimplência.

Onde mora o publisher: helper comum `luxorhub_publish` (client Supabase + upsert)
usado pelo `publish_dash`. O repo do hub guarda o schema e as funções
server-side.

---

## 4. Stack do front

- **SPA com build (Vite + React ou Svelte)** — recomendado em vez de vários
  HTML únicos gigantes. Justificativa: várias páginas, nav/tema/auth
  compartilhados, gating por papel, componentes de gráfico reutilizáveis,
  manutenção. O padrão "1 HTML sem build" do controle-de-projetos não escala p/
  6+ dashboards com RBAC.
- **Gráficos: ECharts** — interativo e bonito no nível do Power BI ou acima
  (zoom, tooltip, cross-filter, séries combinadas), gratuito, sem licença por
  usuário. Alternativa React-nativa: Recharts (menos poderoso p/ finanças).
- **Deploy: Netlify** (deploy do repo, agora com build step).
- **Auth: Supabase** — ver seção 4.1.

### 4.1 Autenticação e acesso ao hub

- **Projeto Supabase dedicado ao hub** (novo). O hub é o site completo do P&C +
  board; o controle-de-projetos é **absorvido** como página e seu dado migra pra
  cá (não fica em projeto externo). Decidido — ver seção 8.
- **Login: magic-link (passwordless).** Clica no link do e-mail, sem senha e sem
  app autenticador — baixo atrito p/ o board. **Sem MFA por app** (rejeitado por
  fricção).
- **Acesso por allowlist, não por domínio.** `@luxor.com.br` **não** basta.
  Signup público **desligado**; só entra e-mail presente na tabela `allowed_users`.
  Repo é privado, mas a lista vive no Supabase (gestão + não versionar e-mails).
- **Step-up opcional só na inadimplência**: como é a tela com PII, pode exigir um
  **código por SMS ao abrir aquela seção** (step-up). Telas normais não pedem
  nada; só a sensível. Custa por SMS, mas só nesse acesso. A decidir — seção 8.

### 4.2 Papéis e administração (RBAC)

- **`admin` (Arthur Martins)** — acesso master. Painel no próprio hub para:
  - liberar/revogar usuários (gerir a `allowed_users`);
  - definir, **por usuário, quais dashboards ele vê** — incluindo quem tem acesso
    à inadimplência e ao dado identificável.
- **`user`** — vê apenas os dashboards que o admin liberou pra ele.
- Modelo: tabela de permissões **usuário × dashboard** (`user_dashboard_access`),
  gerida pelo admin. RLS no banco garante que o usuário só lê o que foi liberado
  (segurança no servidor, não no front).
- Allowlist inicial: 9 e-mails `@luxor.com.br` (seed no setup).

---

## 5. LGPD — proteção do dado de inadimplência

O único dataset com dado pessoal (devedores). Desenho de proteção:

- **Base legal**: cobrança/execução de contrato e legítimo interesse (LGPD art.
  7, VI/IX). Documentar e validar com jurídico.
- **Minimização**: cada tela recebe só o campo que precisa. Por padrão as telas
  usam agregados (`resumo_por_faixa`, KPIs, `resumo_por_cliente` **com nome
  mascarado**). Linha identificável (`nome_pessoa`, título) é exceção.
- **Segregação**: PII em tabelas próprias, separadas dos agregados; nunca em
  snapshot/JSON estático, nunca em bucket público, nunca em `localStorage`,
  nunca em cache de CDN, nunca no Git.
- **Controle de acesso (RBAC + RLS no banco)** — a segurança mora no servidor,
  não no front:
  - `viewer_pc` → só agregados e nomes mascarados.
  - `cobranca` → linhas identificáveis; **todo acesso logado**.
  - RLS/coluna aplicada via **RPC / Edge Function**, não expondo a tabela direta
    à anon key (anon key é pública; só RLS forte protege).
- **Auditoria**: tabela de log — quem acessou dado identificável, quando, qual
  registro. Reter o log.
- **Transporte/repouso**: HTTPS ponta a ponta; Supabase criptografa em repouso.
- **Retenção/eliminação**: política de expurgo de títulos quitados após o prazo
  legal.

Consequência de projeto: a página de inadimplência é a **última** a ser
construída e a única que exige Edge Functions/RPC + tabela de auditoria.

---

## 6. Estrutura do repo (proposta)

```
LuxorP&CHub/
  src/
    pages/
      indicadores/        # tabela cotações + %Dia/MTD/QTD/YTD/36M, slicer FUNDO + datas
      dre/                # Orçado×Realizado (barras) + Comparativo YTD; slicers Modelo/CC/Natureza
      fluxo-caixa/
      participacoes/
      plantel-vendas/
      inadimplencia/      # agregados por padrão; detalhe atrás de RBAC + auditoria
      projetos/           # migra/embute o controle-de-projetos
    components/           # charts (ECharts wrappers), nav, auth-guard, tema
    lib/                  # supabase client, camada de acesso a dados
  supabase/
    schema.sql            # tabelas, papéis, RLS, tabela de auditoria
    functions/            # Edge Functions / RPC (acesso a PII)
  config.js               # SUPABASE_URL + anon key (pública por design)
  netlify.toml
  docs/ARQUITETURA.md
```

Os `publish_hub.py` ficam nos repos de ETL (perto da fonte), não aqui.

---

## 7. Fases de entrega

1. ✔ **Substituição do link** — Hub estático no Netlify no lugar do
   controle-de-projetos, que virou a aba Projetos (mesmo Supabase, `_redirects`
   preservando os bookmarks antigos).
2. ✔ **Auth global do Hub** — sessão única na casca (magic-link PKCE), allowlist
   `allowed_users` + RBAC `user_dashboard_access`, dado em bucket privado.
3. ✔ **Indicadores** — Azure → `build_data.py` → `publish_hub.py` → bucket.
   Fecha o ciclo ETL→publish→web.
4. ✔ **DRE** — Orçado×Realizado + Comparativo YTD.
5. **Painel de administração** — admin gere allowlist e permissões pela UI
   (hoje é SQL no Supabase).
6. **Fluxo de Caixa + Participações + Plantel/Vendas**.
7. **Inadimplência** — com o desenho LGPD completo (seção 5).

---

## 8. Decisões

Fechadas:

1. **Build** — SPA com build (Vite). ✔
2. **Supabase** — projeto novo dedicado ao hub; controle-de-projetos é absorvido
   como página e seu dado migra pra cá. ✔
3. **Publish** — dois scripts: `run_all_etls` (pergunta se chama o publish no
   fim) + `publish_dash` (re-executável sozinho). ✔
4. **Gráfico** — ECharts. ✔
5. **Acesso** — allowlist invite-only (9 e-mails), signup público desligado,
   login por **magic-link** (sem app autenticador). ✔
6. **Admin** — papel `admin` (Arthur) com painel p/ liberar usuários e definir,
   por usuário, quais dashboards vê (inclui inadimplência). ✔

Pendentes:

- **(a) Step-up na inadimplência** — exigir código por SMS ao abrir só a tela de
  PII, ou o controle por allowlist + admin já basta (sem SMS)?
- **(b) LGPD** — validar base legal e retenção com jurídico antes de subir
  inadimplência.
