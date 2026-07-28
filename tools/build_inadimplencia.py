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
/* ordenação por coluna: seta via CSS, sem mexer no texto do cabeçalho */
thead th{cursor:pointer;-webkit-user-select:none;user-select:none}
th.num{text-align:right !important}
thead th:hover{color:var(--accent) !important}
thead th[data-dir]{color:var(--accent) !important}
thead th[data-dir="asc"]::after{content:" ▲";font-size:9px}
thead th[data-dir="desc"]::after{content:" ▼";font-size:9px}
/* cores dos cards: injetadas de KPI_CSS, iguais às dos gráficos */
KPI_CSS_AQUI
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

# Ordenação por coluna. Cópia do que foi adicionado ao ControleInadimplencia.py
# (lá é a fonte). Serve o HTML gerado ANTES daquela correção; depois que o
# gerador rodar de novo, o marcador já existe e este bloco não é injetado.
MARCADOR_ORDENACAO = "Ordenacao por coluna"
SORT_JS = r"""
<script>
// ---- Ordenacao por coluna (marcador: tabela-ordenavel) ----
// Clique no cabecalho ordena a tabela. Delegado no document porque as tabelas
// sao reconstruidas via innerHTML quando os filtros mudam - listener preso ao
// <th> se perderia no primeiro filtro.
(function () {
  // "R$ 1.234,56" / "12,3%" / "1.234" -> numero;  "31/12/2026" -> 20261231
  function valorDe(td) {
    const s = ((td && td.textContent) || '').trim();
    if (!s || s === '-' || s === '–') return { n: null, s: '' };
    const d = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (d) return { n: +(d[3] + d[2] + d[1]), s };
    const num = s.replace(/[R$\s%]/g, '').replace(/\./g, '').replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(num)
      ? { n: parseFloat(num), s }
      : { n: null, s: s.toLowerCase() };
  }
  // Olha ate 10 linhas: a primeira pode estar vazia e mascarar a coluna.
  function colunaNumerica(linhas, i) {
    for (const r of linhas.slice(0, 10)) {
      const v = valorDe(r.cells[i]);
      if (v.n !== null) return true;
      if (v.s) return false;
    }
    return false;
  }
  document.addEventListener('click', function (e) {
    const th = e.target.closest && e.target.closest('th');
    if (!th) return;
    const thead = th.closest('thead');
    const table = thead && thead.closest('table');
    const tbody = table && table.tBodies[0];
    if (!tbody) return;
    const i = [].indexOf.call(th.parentNode.cells, th);
    const todas = [].slice.call(tbody.rows);
    const totais = todas.filter(r => /row-total/.test(r.className));
    const dados = todas.filter(r => !/row-total/.test(r.className));
    if (dados.length < 2) return;
    // 1o clique: numero desce (maior primeiro), texto sobe (A-Z).
    const num = colunaNumerica(dados, i);
    const padrao = num ? 'desc' : 'asc';
    const dir = th.dataset.dir === padrao ? (padrao === 'asc' ? 'desc' : 'asc') : padrao;
    dados.sort(function (a, b) {
      const x = valorDe(a.cells[i]), y = valorDe(b.cells[i]);
      if (x.n !== null && y.n !== null) return dir === 'asc' ? x.n - y.n : y.n - x.n;
      if (x.n !== null) return -1;          // valor antes de vazio, nos dois sentidos
      if (y.n !== null) return 1;
      const r = x.s.localeCompare(y.s, 'pt-BR');
      return dir === 'asc' ? r : -r;
    });
    thead.querySelectorAll('th[data-dir]').forEach(t => t.removeAttribute('data-dir'));
    th.dataset.dir = dir;   // a seta vem do CSS, nao mexe no texto do cabecalho
    dados.concat(totais).forEach(r => tbody.appendChild(r));
  });

  // Alinha cabecalho com a coluna. O gerador marca so parte das colunas com
  // class="num" (inteiros como "Qt Titulos" ficavam a esquerda) e o <th> e'
  // sempre text-align:left, entao cabecalho e valor nao batiam. Usa a MESMA
  // deteccao da ordenacao, entao alinhamento e ordem nunca discordam.
  function alinhar(table) {
    const thead = table.tHead, tbody = table.tBodies[0];
    if (!thead || !tbody || !thead.rows.length) return;
    const ths = thead.rows[thead.rows.length - 1].cells;
    const dados = [].slice.call(tbody.rows).filter(r => !/row-total/.test(r.className));
    for (let i = 0; i < ths.length; i++) {
      if (!colunaNumerica(dados, i)) continue;
      ths[i].classList.add('num');
      [].forEach.call(tbody.rows, r => { if (r.cells[i]) r.cells[i].classList.add('num'); });
    }
  }
  function alinharTudo(raiz) {
    if (raiz && raiz.querySelectorAll) raiz.querySelectorAll('table').forEach(alinhar);
  }
  // As tabelas sao recriadas via innerHTML a cada filtro, entao observa o DOM
  // em vez de alinhar so no carregamento.
  new MutationObserver(function (muts) {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'TABLE') alinhar(n); else alinharTudo(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
  alinharTudo(document);
})();
</script>
"""

# ── Cores das categorias ───────────────────────────────────────────────────────
# Vermelho em Inadimplentes, laranja em Ação Judicial.
# O laranja NÃO é o #FFA400 da paleta: ele fica a 8° de matiz do amarelo
# #f6c000 (Não Entregues) e os dois viram a mesma cor numa fatia de donut.
# #F76707 é o mesmo laranja, mais fechado — 24° do vermelho e 23° do amarelo,
# no meio exato dos dois vizinhos, e contraste 4.6 (o #FF0000 tem 3.5).
A_VENCER  = "#346e79"   # teal claro   contraste 2.4
N_ENTREG  = "#f6c000"   # amarelo      contraste 8.3
JUDICIAL  = "#F76707"   # laranja      contraste 4.6
INADIMPL  = "#FF0000"   # vermelho     contraste 3.5
VENCIDO   = "#D9D9D9"   # cinza        contraste 9.9  (só na barra)

# Série "Inadimplente" da barra por ano. O gerador já acumulava `r.inad` em
# aggregateByYear mas não plotava — corrigido no ControleInadimplencia.py.
# Este insert cobre o HTML gerado ANTES daquela correção; depois que o gerador
# rodar de novo a série já vem pronta e o insert não faz nada (é idempotente).
ANCORA_VENCIDO = "return r.total>0 ? r.venc/r.total*100 : 0;})},"
SERIE_INADIMPLENTE = (
    "\n    {label:'Inadimplente/Total', color:'#dc2626', data: years.map(y => "
    "{const r=byYear.get(y); return r.total>0 ? r.inad/r.total*100 : 0;})},"
)

# Correções cirúrgicas de cor NA FONTE (o gerador crava cores claras/berrantes).
# Ordem importa: Chart.defaults.color é trocado antes do replace de '#525252'.
COLOR_FIXES = [
    ("Chart.defaults.color = '#525252'", "Chart.defaults.color = '#C4DBDD'"),      # texto eixos/ticks
    ("Chart.defaults.borderColor = '#e5e5e5'", "Chart.defaults.borderColor = 'transparent'"),
    ("grid:{color:'#f5f5f4', drawBorder:false}", "grid:{display:false}"),          # remove grade
    ("borderColor:'#fff'", "borderColor:'#12303A'"),                               # separador do donut
    ("color:'#171717'", "color:'#EAF4F4'"),                                        # texto da legenda
    # ATENÇÃO: '#525252' com aspas SIMPLES é texto de eixo (ticks x/y), não é
    # categoria. Trocar essa string por cor de categoria pintaria os rótulos
    # dos eixos. As cores do donut moram só nas entradas da paleta, adiante.
    ("'#525252'", "'#D9D9D9'"),                                                    # ticks dos eixos
    # --- barra "% do total por ano": cada série tem cor cravada no JS ---
    ("color:'#9e9e9e'", f"color:'{VENCIDO}'"),                                     # Vencido
    ("color:'#dc2626'", f"color:'{INADIMPL}'"),                                    # Inadimplente
    ("color:'#1a237e'", f"color:'{JUDICIAL}'"),                                    # Ação Judicial
    ("color:'#e65100'", f"color:'{N_ENTREG}'"),                                    # Não Entregue
    # --- donut: lê de DATA.palette[categoria] ---
    ('"A_VENCER": "#16a34a"',      f'"A_VENCER": "{A_VENCER}"'),
    ('"NAO_ENTREGUES": "#ea580c"', f'"NAO_ENTREGUES": "{N_ENTREG}"'),
    ('"INADIMPLENTE": "#dc2626"',  f'"INADIMPLENTE": "{INADIMPL}"'),
    ('"ACAO_JUDICIAL": "#525252"', f'"ACAO_JUDICIAL": "{JUDICIAL}"'),
]

# Cor do KPI por rótulo (sobrescreve a classe original do gerador).
# '' = neutro (branco). yellow = atenção/vencido. red = ação judicial.
# Card na MESMA cor da fatia do donut / série da barra.
KPI_COLOR = [
    ("Total em Aberto", ""), ("Vencidos", ""), ("A Vencer", ""),
    ("Inadimplentes", "red"), ("Judicial", "orange"), ("Entregues", "yellow"),
]
# CSS gerado a partir das constantes acima — não repetir hex à mão, senão card
# e gráfico saem de sincronia (já aconteceu).
KPI_CSS = "\n".join(f".kpi-card.{cls} .kpi-value{{color:{cor} !important}}"
                    for cls, cor in (("red", INADIMPL), ("orange", JUDICIAL),
                                     ("yellow", N_ENTREG)))

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

    # 2a) série Inadimplente na barra por ano, se o gerador ainda não a emitir.
    #     Roda ANTES das cores, pra série nova passar pelo mesmo COLOR_FIXES.
    if "r.inad/r.total" not in h:
        if ANCORA_VENCIDO not in h:
            raise RuntimeError("âncora da série Vencido não encontrada — o gerador mudou. "
                               "Conferir pctSeries no ControleInadimplencia.py.")
        h = h.replace(ANCORA_VENCIDO, ANCORA_VENCIDO + SERIE_INADIMPLENTE, 1)
        print("[inadimplencia] série Inadimplente inserida na barra")

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

    # 3) injeta override Luxor antes de </head> (KPI_CSS é montado das constantes)
    h = h.replace("</head>", LUXOR_OVERRIDE.replace("KPI_CSS_AQUI", KPI_CSS) + "</head>", 1)

    # 4) logo Luxor no header
    h = h.replace("<header>", '<header><img class="lx-logo" src="../luxor-logo.png" alt="Luxor">', 1)

    # 5) caminhos relativos -> absolutos. Em produção o arquivo é servido como
    #    blob: (vem do bucket privado, nunca vira arquivo público) e blob não
    #    tem caminho base, então "../vendor/x" não resolve. O blob herda o
    #    origin do hub, então "/assets/vendor/x" resolve nos dois casos.
    for rel, absolute in (("../vendor/", "/assets/vendor/"),
                          ("../fonts.css", "/assets/fonts.css"),
                          ("../luxor-logo.png", "/assets/luxor-logo.png")):
        h = h.replace(rel, absolute)

    # 6) ordenação por coluna, se o gerador ainda não a trouxer
    if MARCADOR_ORDENACAO not in h:
        h = h.replace("</body>", SORT_JS + "</body>", 1)
        print("[inadimplencia] ordenação por coluna injetada")

    OUT.write_text(h, encoding="utf-8")
    print(f"[inadimplencia] {len(h)//1024} KB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    run()
