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
# Fonte = repo local do controle-de-inadimplencia (fonte da verdade).
SRC = Path(r"C:/Users/Arthur/repos/controle-de-inadimplencia/output_pbi/dashboard_conferencia.html")
OUTDIR = ROOT / "assets" / "inadimplencia"
OUTDIR.mkdir(parents=True, exist_ok=True)
OUT = OUTDIR / "dashboard.html"

LUXOR_OVERRIDE = """
<link rel="stylesheet" href="../fonts.css">
<style>
/* ===== Identidade Luxor (override do tema claro original) — alto contraste ===== */
:root{
  --bg:#0A1B20; --surface:#12303A; --surface-2:#1C4653;
  --text:#F3F9F9; --text-2:#C4DBDD; --muted:#8AA6AB;
  --border:rgba(255,255,255,.18); --border-2:rgba(255,255,255,.34);
  --accent:#FFA400; --accent-soft:rgba(255,164,0,.16); --accent-hover:#FFB733;
  --ok:#54C983; --warn:#F5C95B; --danger:#F0705A;
}
body{font-family:'Fakt Pro',system-ui,-apple-system,'Segoe UI',sans-serif !important;
  background:var(--bg) !important;color:var(--text) !important}
/* header interno escondido (o hub já tem topbar) + aproveita a largura toda */
header{display:none !important}
.container{max-width:none !important;padding:16px 22px 34px !important}
/* superfícies (fundo explícito p/ contraste) */
.kpi-card,section,.chart-box,.section-filters{background:var(--surface) !important;border-color:var(--border) !important}
.kpi-card:hover,section:hover{border-color:var(--border-2) !important}
.kpi-label,.kpi-sub{color:var(--text-2) !important}
.kpi-value{color:var(--text) !important}
/* cor por natureza: amarelo=vencido/atenção · vermelho=ação judicial · branco=total/a vencer */
.kpi-card.yellow .kpi-value{color:#f6c000 !important}
.kpi-card.red .kpi-value{color:#FF0000 !important}
/* scrollbars discretas (mata o quadrado branco no canto) */
::-webkit-scrollbar{height:9px;width:9px}
::-webkit-scrollbar-track{background:transparent !important}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18) !important;border-radius:5px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.30) !important}
::-webkit-scrollbar-corner{background:transparent !important}
section h2,.chart-box h2{color:var(--text) !important;border-bottom-color:var(--border) !important}
/* status / avisos */
.status-bar{background:var(--accent-soft) !important;color:var(--accent) !important;
  border:1px solid rgba(255,164,0,.4) !important}
/* controle de desconto */
.desconto-control{background:var(--accent-soft) !important;border-color:rgba(255,164,0,.4) !important;color:var(--text-2) !important}
/* tabelas */
th{background:#0A1B20 !important;color:var(--text-2) !important;border-bottom-color:var(--border) !important}
td{color:var(--text) !important;border-bottom-color:var(--border) !important}
td.num.neg,td.neg{color:var(--danger) !important}
tbody tr:hover td{background:rgba(255,255,255,.05) !important}
tr.row-total td{background:var(--surface-2) !important}
/* inputs/botões */
select,input,.btn{background:var(--surface-2) !important;color:var(--text) !important;border-color:var(--border) !important}
.btn:hover{background:#24505d !important}
option{background:#0A1B20;color:var(--text)}
/* coluna "Compra" não quebrar letra-a-letra + usar melhor a largura */
td.compra>div{max-width:none !important;white-space:normal !important;overflow-wrap:break-word !important;word-break:normal !important}
.container{max-width:none !important}
table{table-layout:auto !important}
/* tags de categoria — tints escuros legíveis */
.tag-LATINO{background:rgba(46,151,166,.28) !important;color:#a9e4ec !important}
.tag-CONDOMINIO{background:rgba(255,164,0,.24) !important;color:#ffca70 !important}
.tag-DAMASCO{background:rgba(245,201,91,.22) !important;color:#f5d780 !important}
.tag-LOTUS{background:rgba(240,112,90,.24) !important;color:#f5a596 !important}
</style>
"""

CHART_DARK = r"""
<script>if(window.Chart){Chart.defaults.font.family="Fakt Pro, system-ui, sans-serif";}</script>
<script>document.addEventListener('DOMContentLoaded',function(){
  var m={};[].forEach.call(document.querySelectorAll('.kpi-card'),function(c){var l=c.querySelector('.kpi-label');if(l)m[l.textContent.trim()]=c;});
  // Vencidos logo depois de A Vencer
  if(m['A Vencer']&&m['Vencidos']&&m['A Vencer'].parentNode)
    m['A Vencer'].parentNode.insertBefore(m['Vencidos'],m['A Vencer'].nextSibling);
});</script>
"""

# Correções cirúrgicas de cor NA FONTE (o gerador crava cores claras/berrantes).
# Ordem importa: Chart.defaults.color é trocado antes do replace global de '#525252'.
# Paleta oficial Luxor: #FF0000 #FFA400 #D9D9D9 #1D6E79 #1c3e44 #346e79 #f6c000
COLOR_FIXES = [
    ("Chart.defaults.color = '#525252'", "Chart.defaults.color = '#C4DBDD'"),      # texto eixos/ticks
    ("Chart.defaults.borderColor = '#e5e5e5'", "Chart.defaults.borderColor = 'transparent'"),
    ("grid:{color:'#f5f5f4', drawBorder:false}", "grid:{display:false}"),          # remove grade
    ("borderColor:'#fff'", "borderColor:'#12303A'"),                               # separador do donut
    ("color:'#171717'", "color:'#EAF4F4'"),                                        # texto da legenda
    ("color:'#9e9e9e'", "color:'#D9D9D9'"),                                        # Vencido (barra)
    ("color:'#1a237e'", "color:'#1D6E79'"),                                        # Ação Judicial (barra) -> teal
    ("color:'#e65100'", "color:'#FFA400'"),                                        # Não Entregue (barra)
    ("'#16a34a'", "'#346e79'"),                                                     # A Vencer -> teal claro (contraste no dark)
    ('"#16a34a"', '"#346e79"'),                                                     # (variante aspas duplas / JSON)
    ("'#dc2626'", "'#FF0000'"),                                                     # Inadimplentes -> vermelho Luxor
    ('"#dc2626"', '"#FF0000"'),
    ("'#ea580c'", "'#FFA400'"),                                                     # Não Entregues -> laranja
    ('"#ea580c"', '"#FFA400"'),
    ("'#525252'", "'#D9D9D9'"),                                                     # Ação Judicial (donut) -> cinza Luxor
    ('"#525252"', '"#D9D9D9"'),
]

# Cor do KPI por rótulo (sobrescreve a classe original do gerador).
# '' = neutro (branco). yellow = atenção/vencido. red = ação judicial.
KPI_COLOR = [
    ("Total em Aberto", ""), ("Vencidos", ""), ("A Vencer", ""),
    ("Inadimplentes", "red"), ("Judicial", "yellow"), ("Entregues", "yellow"),
]

# Renome de rótulos
LABEL_FIXES = [
    ("Vencido &gt; 7 dias", "Vencidos"),
    ("Inadimplentes L&iacute;quido", "Inadimplentes"),
]


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

    # 2b) cores dos gráficos -> paleta Luxor (cirúrgico, na ordem definida)
    for a, b in COLOR_FIXES:
        h = h.replace(a, b)

    # 2b2) renomeia rótulos dos KPIs
    for a, b in LABEL_FIXES:
        h = h.replace(a, b)

    # 2c) cor dos KPIs por rótulo (troca a classe do card conforme o label)
    for label, cls in KPI_COLOR:
        newc = "kpi-card " + cls if cls else "kpi-card"
        pat = r'class="kpi-card[^"]*"((?:(?!kpi-card).)*?kpi-label">[^<]*?' + re.escape(label) + r')'
        h = re.sub(pat, lambda m, nc=newc: f'class="{nc}"' + m.group(1), h, count=1, flags=re.S)

    # 3) injeta override Luxor antes de </head>
    h = h.replace("</head>", LUXOR_OVERRIDE + "</head>", 1)

    # 4) logo Luxor no header
    h = h.replace("<header>", '<header><img class="lx-logo" src="../luxor-logo.png" alt="Luxor">', 1)

    OUT.write_text(h, encoding="utf-8")
    print(f"[inadimplencia] {len(h)//1024} KB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    run()
