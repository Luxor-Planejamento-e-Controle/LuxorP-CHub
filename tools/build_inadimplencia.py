"""Migra o dashboard de inadimplência (gerado por ControleInadimplencia.py) para a
identidade visual Luxor, SEM reescrever a lógica. O CSS de origem é todo baseado
em variáveis, então redefinimos o :root (tema escuro Luxor) + poucos overrides
pontuais (status-bar, tags, desconto) e trocamos Chart.js CDN por vendor local.

Saída: assets/inadimplencia/dashboard.html (gitignored — contém PII).
Uso: python tools/build_inadimplencia.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(r"G:/Drives compartilhados/Luxor Controladoria/Ambiente de testes/Controle de inadimplência/output_pbi/dashboard_conferencia.html")
OUTDIR = ROOT / "assets" / "inadimplencia"
OUTDIR.mkdir(parents=True, exist_ok=True)
OUT = OUTDIR / "dashboard.html"

LUXOR_OVERRIDE = """
<link rel="stylesheet" href="../fonts.css">
<style>
/* ===== Identidade Luxor (override do tema claro original) ===== */
:root{
  --bg:#0D2126; --surface:#143840; --surface-2:#1B4650;
  --text:#EAF4F4; --text-2:#A7C3C5; --muted:#6E8C90;
  --border:rgba(255,255,255,.13); --border-2:rgba(255,255,255,.24);
  --accent:#FFA400; --accent-soft:rgba(255,164,0,.14); --accent-hover:#E08E00;
  --ok:#46B678; --warn:#F2C14E; --danger:#E5674E;
}
body{font-family:'Fakt Pro',system-ui,-apple-system,'Segoe UI',sans-serif !important;
  background:var(--bg) !important;color:var(--text)}
header{background:linear-gradient(180deg,#113036,#143840)}
header .lx-logo{height:26px;width:auto;margin-right:14px}
header h1{color:var(--text)}
/* status / avisos */
.status-bar{background:var(--accent-soft) !important;color:var(--accent) !important;
  border:1px solid rgba(255,164,0,.35) !important}
/* controle de desconto */
.desconto-control{background:var(--accent-soft) !important;border-color:rgba(255,164,0,.35) !important}
/* tags de categoria — tints escuros legíveis */
.tag-LATINO{background:rgba(46,151,166,.18);color:#8fd3dd}
.tag-CONDOMINIO{background:rgba(255,164,0,.16);color:#ffc766}
.tag-DAMASCO{background:rgba(242,193,78,.16);color:#f2c14e}
.tag-LOTUS{background:rgba(229,103,78,.16);color:#f0a091}
/* inputs/botões herdam via var; garante contraste do foco */
select,input,.btn{background:var(--surface) !important;color:var(--text) !important}
option{background:#0b1f24;color:var(--text)}
th{background:#0b1f24 !important}
tbody tr:hover td{background:rgba(255,255,255,.04) !important}
</style>
"""

CHART_DARK = """
<script>
if(window.Chart){
  Chart.defaults.color='#A7C3C5';
  Chart.defaults.borderColor='rgba(255,255,255,.10)';
  Chart.defaults.font.family="Fakt Pro, system-ui, sans-serif";
}
</script>
"""


def run():
    h = SRC.read_text(encoding="utf-8", errors="ignore")

    # 1) Chart.js CDN -> vendor local
    h = h.replace("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
                  "../vendor/chart.umd.min.js")
    # defaults dark logo após o carregamento do Chart.js (antes dos scripts do body)
    h = h.replace('<script src="../vendor/chart.umd.min.js"></script>',
                  '<script src="../vendor/chart.umd.min.js"></script>' + CHART_DARK)

    # 2) neutraliza @import do Google Fonts (offline)
    h = re.sub(r"@import url\('https://fonts\.googleapis[^']*'\);", "", h)

    # 3) injeta override Luxor antes de </head>
    h = h.replace("</head>", LUXOR_OVERRIDE + "</head>", 1)

    # 4) logo Luxor no header
    h = h.replace("<header>", '<header><img class="lx-logo" src="../luxor-logo.png" alt="Luxor">', 1)

    OUT.write_text(h, encoding="utf-8")
    print(f"[inadimplencia] {len(h)//1024} KB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    run()
