# LuxorP&CHub

Hub Planejamento & Controle Luxor. Site único que reúne os dashboards do P&C +
board (Indicadores, DRE, Fluxo de Caixa, Participações, Plantel/Vendas,
Inadimplência, Projetos).

Arquitetura completa: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Versão offline

Casca do hub com **identidade visual do controle-de-projetos** (tema Luxor,
fontes Fakt Pro, logo real) e **dados reais** — sem login, sem backend, sem internet.

**Como abrir**: duplo-clique em `index.html`. Funciona via `file://`, tudo local.

**Gerar os dados** (uma vez, e a cada atualização das bases):

```bash
python tools/build_data.py
```

Lê as fontes reais e grava `assets/data/*.js` (embutidos, p/ funcionar em `file://`):

- **Indicadores** — parquet no Azure Blob (`luxor-planejamento-e-controle`,
  `LuxorControlDatabase/Indicadores_financeiros.parquet`). 14 índices
  (Dólar, Mangalarga, Lipizzaner, IPCA, CDI, CHF, CPI, IGP-M, S&P/SOFR, …),
  histórico 2020→2026. Colunas Cotação, %Dia/MTD/QTD/YTD/36M.
- **DRE** — `DRE Data/DRE_Historico.xlsx` no Drive (Base YTD Unpivot + Base DRE
  Geral). Filtros do PBIX: Modelo (Caixa/Competência), Centro de Custo (FPG/HPG),
  Acumulado, Natureza Ordenada. Orçado × Realizado por ano + série mensal.

**Inadimplência** (dashboard com PII, à parte):

```bash
python tools/build_inadimplencia.py
```

Pega o `dashboard_conferencia.html` (gerado pelo `ControleInadimplencia.py`) e
aplica a identidade Luxor sem mexer na lógica (re-skin via `:root` + Chart.js
vendorizado) → `assets/inadimplencia/dashboard.html`, embutido no hub por iframe.
**Contém PII** — pasta no `.gitignore`, nunca versionar.

Arquivos: `index.html`, `assets/theme.css`, `assets/fonts.css`, `assets/app.js`,
`assets/vendor/echarts.min.js`, `assets/luxor-logo.png`, `tools/build_data.py`.

> ⚠ `assets/data/` tem dado financeiro real — está no `.gitignore`, não é
> versionado. Regenerar com `build_data.py`. Inadimplência (PII) fica de fora.

## Próximos passos

Ver fases em [docs/ARQUITETURA.md](docs/ARQUITETURA.md): scaffold Vite + Supabase
→ Indicadores → DRE → demais → Inadimplência → Projetos.
