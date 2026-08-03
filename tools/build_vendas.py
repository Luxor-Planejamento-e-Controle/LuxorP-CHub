"""Migra o dashboard de Vendas x Valor no Plantel (gerado por LxVendasVsValor.py,
no repo LuxorMonthlyP-CRoutines) para a identidade visual Luxor, SEM reescrever a
lógica. A fonte já é escura (navy/dourado do Haras Pão Grande) e todo o CSS sai de
variáveis no `:root`, então basta redefinir o `:root` + poucos overrides pontuais.

Diferente da inadimplência, aqui não há CDN pra vendorizar: o HTML é autocontido
(logo em data:URI, gráficos em SVG inline, zero referência externa) — o build
verifica isso e falha se algo externo aparecer, porque em produção o arquivo é
servido por `srcdoc` e um asset externo silenciosamente não carregaria.

Saída: assets/vendas/dashboard.html (gitignored — a tabela de detalhe tem nome de
cliente, mesma classe de PII da inadimplência).
Uso: python tools/build_vendas.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Fonte = repo local do LuxorMonthlyP-CRoutines (fonte da verdade).
SRC = Path(r"C:/Users/Arthur/repos/LuxorMonthlyP-CRoutines/Controle de vendas HPG/dashboard_vendas.html")
OUTDIR = ROOT / "assets" / "vendas"
OUT = OUTDIR / "dashboard.html"

LUXOR_OVERRIDE = """
<link rel="stylesheet" href="/assets/fonts.css">
<style>
/* ===== Identidade Luxor (override do tema Haras Pão Grande da fonte) ===== */
/* A fonte usa navy #04223B + dourado #CA9703; aqui vale a paleta do hub. Só o
   :root muda — o resto do CSS original já lê tudo daqui. */
:root{
  --bg:#0A1B20; --card:#12303A; --line:rgba(255,255,255,.18);
  --txt:#F3F9F9; --mut:#8AA6AB;
  --amber:#FFA400;          /* accent (era o dourado do HPG) */
  --teal:#2E97A6;           /* 2ª série dos gráficos */
  --pos:#54C983; --neg:#F0705A;
}
body{font-family:'Fakt Pro',system-ui,-apple-system,'Segoe UI',sans-serif !important}
/* header interno escondido: o hub já tem topbar com o título da aba */
header{display:none !important}
/* aproveita a largura toda do iframe */
.wrap{padding:16px 22px 34px !important;max-width:none !important}
/* o original cravava o navy #103A5E no hover */
tbody tr:hover{background:rgba(255,255,255,.05) !important}
/* fundo explícito nas superfícies: dentro do iframe não há herança do hub */
.kpi,.panel,.scroll,th{background:var(--card)}
option{background:#12303A;color:var(--txt)}
/* scrollbars discretas, igual às outras abas */
::-webkit-scrollbar{height:9px;width:9px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:5px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.30)}
::-webkit-scrollbar-corner{background:transparent}
</style>
"""


def run():
    if not SRC.exists():
        sys.exit(f"Fonte não encontrada: {SRC}\n"
                 f"Rode o LxVendasVsValor.py no repo LuxorMonthlyP-CRoutines primeiro.")

    h = SRC.read_text(encoding="utf-8", errors="ignore")

    # Em produção o HTML vem do bucket privado e entra por `srcdoc` — sem base de
    # URL própria. Referência externa (CDN, fonte, imagem) não carregaria, e
    # falhar aqui é melhor do que publicar um painel com gráfico faltando.
    externos = sorted(set(re.findall(r'(?:src|href)=["\'](https?://[^"\']+)', h)))
    externos = [u for u in externos if "fonts.css" not in u]
    if externos:
        sys.exit("A fonte ganhou referência externa — vendorize antes de publicar:\n  "
                 + "\n  ".join(externos))

    if "</head>" not in h:
        sys.exit("HTML sem </head> — o gerador mudou de forma; conferir LxVendasVsValor.py.")
    h = h.replace("</head>", LUXOR_OVERRIDE + "</head>", 1)

    OUTDIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(h, encoding="utf-8")
    print(f"[vendas] {len(h.encode('utf-8')) // 1024} KB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    run()
