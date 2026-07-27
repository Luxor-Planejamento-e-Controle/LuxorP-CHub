# LuxorP&CHub

Hub Planejamento & Controle Luxor. Site único que reúne os dashboards do P&C +
board (Indicadores, DRE, Fluxo de Caixa, Participações, Plantel/Vendas,
Inadimplência, Projetos).

Arquitetura completa: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).
Deploy passo a passo: [docs/DEPLOY.md](docs/DEPLOY.md).

> ⚠ **Repositório PÚBLICO** (exigência do plano do Netlify para deploy contínuo).
> Só a casca do site vive aqui. Nenhum dado real, e-mail da allowlist, planilha
> ou segredo — tudo isso fica no Supabase, atrás de auth + RLS. A anon key em
> `assets/config.js` é pública por design; a `service_role`, **jamais**.
>
> Antes do primeiro commit neste clone:
>
> ```bash
> python tools/install_hooks.py
> ```
>
> Instala o `pre-commit` que recusa dado real, PII, e-mail `@luxor.com.br` e
> segredo. Não é substituto de atenção, é rede de segurança.

## Como funciona

- **Front**: estático (sem build), publicado no Netlify a partir deste repo.
- **Porta de entrada**: `assets/auth.js` — magic-link do Supabase, allowlist
  (`allowed_users`) e permissão por dashboard (`user_dashboard_access`). Sem
  sessão válida a casca não monta e nenhum dado é baixado. Aba fora da permissão
  do usuário nem aparece na navegação.
- **Dados**: os ETLs geram snapshots que vão para o bucket **privado**
  `hub-data` do Supabase. O navegador só baixa autenticado (policy usa
  `hub_can('<dashboard>')`). **Nada de dado financeiro em arquivo estático
  público** — por isso `assets/data/` continua no `.gitignore`.
- **Projetos**: o app `controle-de-projetos` foi absorvido em
  `assets/projetos/` e roda em iframe do mesmo origin, reaproveitando a sessão
  do hub (não pede login de novo). Dado segue em `app_state` + realtime.

## Setup do Supabase (uma vez)

1. SQL editor → rodar [`sql/hub_schema.sql`](sql/hub_schema.sql)
   (allowlist, RBAC, bucket privado, auditoria).
2. Semear a allowlist com os e-mails reais — modelo em
   [`sql/seed_allowlist.example.sql`](sql/seed_allowlist.example.sql).
   **Os e-mails não vivem no Git**, só no Supabase.
3. Authentication → Providers → Email: **desligar signup público**
   (só entra quem está na allowlist).
4. Authentication → URL Configuration: `Site URL` = URL do Netlify;
   adicionar a mesma URL em `Redirect URLs`.
5. Só depois de (2), descomentar o bloco 6 do `hub_schema.sql` para fechar o
   `app_state` (Projetos) na allowlist no lugar do domínio aberto.

## Publicar dados

```bash
python tools/build_data.py     # lê as fontes reais -> assets/data/*.json e *.js
python tools/publish_hub.py    # sobe os .json para o bucket privado hub-data
```

`publish_hub.py` precisa de um `.env` na raiz (gitignored) com `SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY`. A service_role ignora RLS — nunca no front, nunca no Git.

Fontes:

- **Indicadores** — parquet no Azure Blob (`luxor-planejamento-e-controle`,
  `LuxorControlDatabase/Indicadores_financeiros.parquet`). 14 índices
  (Dólar, Mangalarga, Lipizzaner, IPCA, CDI, CHF, CPI, IGP-M, S&P/SOFR, …),
  histórico 2020→2026. Colunas Cotação, %Dia/MTD/QTD/YTD/36M.
- **DRE** — `DRE Data/DRE_Historico.xlsx` no Drive (Base YTD Unpivot + Base DRE
  Geral). Filtros do PBIX: Modelo (Caixa/Competência), Centro de Custo (FPG/HPG),
  Acumulado, Natureza Ordenada. Orçado × Realizado por ano + série mensal.

## Deploy no Netlify

Sem build command, publish directory = raiz (`netlify.toml` já cobre).
Para substituir o link atual: no site existente do Netlify, trocar o repo
conectado de `controle-de-projetos` para `LuxorP-CHub`. O `_redirects` mantém
`/dashboard-projetos.html` e `/projetos` funcionando (bookmarks antigos).

Antes de promover, testar no deploy preview: login por magic-link, a aba
Projetos abrindo sem segundo login, salvar um projeto e ver o realtime.

## Demo offline

`index.html` aberto via `file://` pula o login e usa os `assets/data/*.js`
gerados localmente. Serve pra conferir layout sem depender do Supabase.

## Inadimplência

```bash
python tools/build_inadimplencia.py
```

Pega o `dashboard_conferencia.html` (gerado pelo `ControleInadimplencia.py`) e
aplica a identidade Luxor sem mexer na lógica (re-skin via `:root` + Chart.js
vendorizado) → `assets/inadimplencia/dashboard.html`.

**Contém PII.** Fica no `.gitignore`, não é publicado e a aba está marcada
`staged` no `assets/app.js` — fora da navegação em produção até o desenho
LGPD/RBAC da seção 5 da arquitetura estar de pé. Só aparece na demo offline.

## Próximos passos

Ver fases em [docs/ARQUITETURA.md](docs/ARQUITETURA.md): painel de administração
(admin gerindo allowlist e permissões pela própria UI) → Fluxo de Caixa,
Participações, Plantel/Vendas → Inadimplência com RBAC/RLS/auditoria.
