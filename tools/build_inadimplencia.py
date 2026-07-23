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
.kpi-card.red .kpi-value{color:var(--danger) !important}
.kpi-card.green .kpi-value{color:var(--ok) !important}
.kpi-card.orange .kpi-value{color:var(--accent) !important}
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
<script>
if(window.Chart){
  var BG='#12303A', GRID='rgba(255,255,255,.05)', AXIS='rgba(255,255,255,.12)', TXT='#EAF4F4', TXT_HI='#F3F9F9';
  Chart.defaults.color=TXT;
  Chart.defaults.borderColor=GRID;
  Chart.defaults.font.family="Fakt Pro, system-ui, sans-serif";
  if(Chart.defaults.plugins&&Chart.defaults.plugins.legend)
    Chart.defaults.plugins.legend.labels.color=TXT_HI;

  // Paleta = mesmas cores do hub Luxor.
  var LUX={red:'#E5674E',orange:'#FFA400',yellow:'#F2C14E',green:'#46B678',teal:'#2E97A6',gray:'#8A9BA0'};
  function parse(c){
    if(typeof c!=='string')return null;
    var m=c.match(/^#([0-9a-f]{3})$/i); if(m){var h=m[1];return[parseInt(h[0]+h[0],16),parseInt(h[1]+h[1],16),parseInt(h[2]+h[2],16)];}
    m=c.match(/^#([0-9a-f]{6})$/i); if(m)return[parseInt(m[1].slice(0,2),16),parseInt(m[1].slice(2,4),16),parseInt(m[1].slice(4,6),16)];
    m=c.match(/rgba?\(([^)]+)\)/i); if(m){var p=m[1].split(',').map(Number);return[p[0],p[1],p[2]];}
    return null;
  }
  function lux(c){
    var rgb=parse(c); if(!rgb)return c;
    var r=rgb[0],g=rgb[1],b=rgb[2],mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
    if(d<38)return LUX.gray;
    var h; if(mx===r)h=60*(((g-b)/d)%6); else if(mx===g)h=60*((b-r)/d+2); else h=60*((r-g)/d+4);
    if(h<0)h+=360;
    if(h<20||h>=345)return LUX.red;
    if(h<45)return LUX.orange;
    if(h<70)return LUX.yellow;
    if(h<170)return LUX.green;
    if(h<260)return LUX.teal;
    return c;
  }
  function remap(v){return Array.isArray(v)?v.map(lux):lux(v);}
  Chart.register({id:'luxorSkin',
    // grade suave + eixos legíveis: setado 1x no config, antes das escalas existirem (seguro).
    beforeInit:function(ch){
      var sc=ch.config.options&&ch.config.options.scales; if(!sc)return;
      Object.keys(sc).forEach(function(k){var s=sc[k]; if(!s||typeof s!=='object')return;
        s.grid=s.grid||{}; s.grid.color=GRID; s.grid.tickColor=GRID; s.grid.drawTicks=false;
        s.ticks=s.ticks||{}; s.ticks.color=TXT;
        s.border=s.border||{}; s.border.color=AXIS;
      });
    },
    // recolore só os datasets (idempotente).
    beforeUpdate:function(ch){
      var t=ch.config.type;
      (ch.data.datasets||[]).forEach(function(ds){
        if(ds.backgroundColor!=null)ds.backgroundColor=remap(ds.backgroundColor);
        if(t==='doughnut'||t==='pie'){ds.borderColor=BG;ds.borderWidth=2;}
        else if(t==='bar'){ds.borderWidth=0;if(ds.borderColor!=null)ds.borderColor=remap(ds.borderColor);}
        else if(ds.borderColor!=null)ds.borderColor=remap(ds.borderColor);
      });
    }});
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

    # 2b) grade dos gráficos: cinza-claro do gerador -> quase invisível no dark
    h = h.replace("color:'#f5f5f4'", "color:'rgba(255,255,255,0.05)'")

    # 3) injeta override Luxor antes de </head>
    h = h.replace("</head>", LUXOR_OVERRIDE + "</head>", 1)

    # 4) logo Luxor no header
    h = h.replace("<header>", '<header><img class="lx-logo" src="../luxor-logo.png" alt="Luxor">', 1)

    OUT.write_text(h, encoding="utf-8")
    print(f"[inadimplencia] {len(h)//1024} KB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    run()
