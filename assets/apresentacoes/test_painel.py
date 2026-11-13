"""Testa os decks do Comitê FO e do Board no hub com o supabase-js REAL e a rede interceptada.

Mesma abordagem dos outros painéis: nada de credencial nem Supabase de verdade — as
requisições do supabase-js são atendidas aqui. A página é servida por HTTP local (e não
file://) para não cair na demo offline, que leria ../data/<deck>.js da máquina.

O payload é SINTÉTICO (números inventados): o repositório é público. Ele traz um slide
de CADA tipo que o ap_layout.js desenha, para que um tipo quebrado apareça aqui.

Uso: python assets/apresentacoes/test_painel.py   (da raiz do repo do hub)
"""

import functools
import http.server
import io
import json
import pathlib
import threading
import unittest
import zipfile

AQUI = pathlib.Path(__file__).resolve().parent
ASSETS = AQUI.parent


def _slides():
    def b(r, v, cor="FFA400"):
        return {"r": r, "v": v, "cor": cor}

    painel = {"barras": [b("Alfa", 0.012), b("Beta", 0.03, "D9D9D9"), b("Gama", -0.018, "FF0000")], "fmt": "pct1"}
    cascata = {"fmt": "num1", "barras": [{"r": "AUM Q2", "v": 100.0, "k": "ini"}, {"r": "Return", "v": -3.0, "k": "d"},
                                         {"r": "Subs", "v": 2.0, "k": "d"}, {"r": "AUM Q3", "v": 99.0, "k": "fim"}]}
    return [
        {"id": "kr", "t": "barras", "titulo": "Performance versus KRs", "destaque": "in %", "nota": "*nota",
         "colunas": ["2026 Q3", "2026 YTD"], "linhas": [[dict(painel, eixo=[-0.2, 0.2]), painel]]},
        {"id": "kr4", "t": "barras", "titulo": "Performance versus", "destaque": "KRs",
         "colunas": ["2026 Q3", "2026 YTD"], "linhas": [[painel, painel], [painel, painel]]},
        {"id": "cartoes", "t": "cartoes", "titulo": "Portfolio", "destaque": "in 2026 Q3", "resumo": ["NAV BRL 10 mm"],
         "cartoes": [{"nome": "Um", "cor": "1D6E79", "linhas": ["BRL 5 mm", "50% of NAV"]},
                     {"nome": "Dois", "cor": "FFC000", "linhas": ["BRL 3 mm", "30% of NAV"]},
                     {"nome": "Três", "cor": "7C7C7C", "linhas": ["BRL 2 mm", "20% of NAV"]}]},
        {"id": "foto", "t": "foto", "img": None, "cartao": {"nome": "Um", "cor": "7C7C7C", "linhas": ["BRL 2 mm"]}},
        {"id": "cascata", "t": "cascata", "titulo": "AUM", "destaque": "in R$ mm", "colunas": ["Q3", "YTD"],
         "paineis": [cascata, cascata]},
        {"id": "ativos", "t": "ativos", "titulo": "Assets analysis", "destaque": "in R$mm", "colunas": ["Q3", "YTD"],
         "linhas": [{"r": "Total", "n": 0, "v": [1, 10, -0.1, -0.01, 0.2, 0.02]},
                    {"r": "Grupo", "n": 1, "v": [0.5, 5, 0.1, 0.02, -0.3, -0.06]},
                    {"r": "Item", "n": 2, "v": [0.5, 5, 0.1, 0.02, -0.3, None]}]},
        {"id": "fcf", "t": "fcf", "titulo": "FCF analysis", "destaque": "in R$mm", "colunas": ["Q3", "YTD"],
         "linhas": [{"r": "Grupo", "n": 1, "v": [2, -0.1, -0.2, -0.09]}, {"r": "Item", "n": 2, "v": [1, 0, 0, 0]}]},
        {"id": "colunas", "t": "colunas", "titulo": "Preços", "destaque": "in R$",
         "paineis": [{"titulo": "Soja", "cor": "FFA400", "fmt": "num1", "barras": [{"r": "Dec-24", "v": 100.0}]},
                     {"titulo": "Boi", "cor": "1D6E79", "fmt": "num1", "barras": [{"r": "Dec-24", "v": 200.0}]}]},
        {"id": "recebiveis", "t": "recebiveis", "titulo": "Recebíveis", "destaque": "in R$mm", "nota": "*nota",
         "legenda": [{"s": "Soy Received", "cor": "FFA400"}, {"s": "Taxes Paid", "cor": "8B0000"}],
         "barras": [{"r": "Apr-23", "partes": [{"s": "Soy Received", "v": 50.0, "cor": "FFA400"},
                                                {"s": "Taxes Paid", "v": -5.0, "cor": "8B0000"}], "total": 50.0, "impostos": -5.0},
                    {"r": "Sep-26", "partes": [{"s": "Soy Received", "v": 40.0, "cor": "FFA400"}], "total": 40.0,
                     "impostos": 0.0, "boi": 0.0, "soja": 40.0}]},
        {"id": "resultado_fo", "t": "resultado_fo", "titulo": "FO Result",
         "linhas": [["Net Result", -1000.5], ["Diff.", 3.25]], "total": ["∆ NAV YTD 2026", -997.25]},
        {"id": "pilhas", "t": "pilhas", "titulo": "New Asset Value", "destaque": "| Growth",
         "legenda": [{"s": "A", "cor": "FFC866"}, {"s": "B", "cor": "31859C"}],
         "barras": [{"r": "Dec-24", "total": 30.0, "partes": [{"s": "A", "v": 10.0, "cor": "FFC866"},
                                                              {"s": "B", "v": 20.0, "cor": "31859C"}]}]},
        {"id": "linhas", "t": "linhas", "titulo": "Leverage & Debt Cost", "nota": ["* a", "** b"],
         "rotulos": ["1Q26", "2Q26", "3Q26"], "eixo": [0, 0.21], "eixo2": [0, 0.72],
         "series": [{"s": "A D/E", "o": 1, "cor": "F2A900", "eixo2": False, "kd": 0.05, "pontos": [[0, 0.1], [2, 0.12]]},
                    {"s": "B D/A", "o": 2, "cor": "FFFFFF", "eixo2": True, "kd": None, "pontos": [[1, 0.6]]}]},
        {"id": "investidores", "t": "investidores", "titulo": "NAV Break Down", "destaque": "by Investors",
         "data": "30/09/2026", "padrao": "BRL",
         "moedas": {k: {"membros": [["Fundo X", 2]], "frase": f"• total em {k}",
                        "barras": [{"r": "Fundo X", "v": 10.0, "k": "d"}, {"r": "Total", "v": 10.0, "k": "fim"}]}
                    for k in ("BRL", "USD")}},
        {"id": "capa", "t": "capa", "texto": "Budget 2026"},
        {"id": "budget_fc", "t": "budget_fc", "titulo": "Budget |", "destaque": "2026",
         "grupos": ["Setembro 2026", "YTD 2026", "Ano 2026"], "cabecalho": "Fluxo de Caixa 2026 | FO",
         "linhas": [{"r": "Receita", "fill": "C4D79B", "b": True, "v": [1, 2, 1, 3, 4, 1, 0.01, 5, 6]}, {"sep": True},
                    {"r": "Variação", "fill": "1A3C34", "b": True, "v": [1, 2, -1, 3, 4, -1, 0, 5, None]}]},
        {"id": "highlights", "t": "highlights", "titulo": "Budget Highlights |", "destaque": "Q3 2026 in R$",
         "quadrantes": [{"q": "Fees", "itens": [{"r": "Funds", "v": 10.0, "fav": True}, {"r": "X", "v": None, "fav": False}]}]},
        {"id": "receita", "t": "receita", "titulo": "Revenue", "destaque": "by Segment @2026",
         "cab": ["Investor", "Revenue in R$mm", "YoY %"], "linhas": [["Grupo", 8.3, -0.053], ["Outro", 0.2, None]]},
        {"id": "pendente", "t": "pendente", "titulo": "sem_dado", "motivo": "base sem o trimestre"},
    ]


def _spec(deck="comite_fo"):
    return {"deck": deck, "titulo": "Deck de Teste", "periodos": ["2026-Q3", "2026-Q2"], "padrao": "2026-Q3",
            "labels": {"2026-Q3": "2026 Q3", "2026-Q2": "2026 Q2"},
            "decks": {"2026-Q3": _slides(), "2026-Q2": _slides()[:3]},
            "gerado_em": "2026-10-10T12:00:00+00:00", "gerado_por_periodo": {"2026-Q3": "2026-10-10T12:00:00+00:00"}}


class Estado:
    def __init__(self, spec=True):
        self.spec = _spec() if spec is True else spec
        self.pedidos = []


class _Silencioso(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def _abrir(caso, estado, deck="comite_fo", hash_=""):
    pg = caso._b.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    erros = []
    pg.on("pageerror", lambda e: erros.append(str(e)))
    pg.on("console", lambda m: erros.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)

    def rota(route):
        url = route.request.url
        if "/functions/v1/reprocessar" in url:
            estado.pedidos.append(json.loads(route.request.post_data or "{}"))
            return route.fulfill(status=200, content_type="application/json", body='{"ok":true}')
        if "/storage/v1/object/" in url and url.split("?")[0].endswith(f"/{deck}.json"):
            if estado.spec is None:
                return route.fulfill(status=400, content_type="application/json",
                                     body=json.dumps({"statusCode": "404", "error": "not_found", "message": "Object not found"}))
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(estado.spec))
        if "/auth/v1/" in url:
            return route.fulfill(status=200, content_type="application/json", body="{}")
        return route.fulfill(status=404, body="")

    pg.route("**/*.supabase.co/**", rota)
    pg.goto(f"{caso._base}/apresentacoes/index.html?deck={deck}{hash_}")
    pg.wait_for_timeout(1200)
    return pg, erros


class TestApresentacoes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        h = functools.partial(_Silencioso, directory=str(ASSETS))
        cls._srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = f"http://127.0.0.1:{cls._srv.server_address[1]}"
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()
        cls._srv.shutdown()

    def test_1_todos_os_tipos_desenham_sem_erro(self):
        pg, erros = _abrir(self, Estado())
        n = len(_slides())
        self.assertEqual(pg.text_content("#pos"), f"1 / {n}")
        for i in range(n):
            self.assertTrue(pg.is_visible("#slide"), f"slide {i + 1}")
            self.assertGreater(pg.locator("#slide .pt, #slide .pr").count(), 0, f"slide {i + 1} vazio")
            pg.keyboard.press("ArrowRight")
        self.assertEqual(pg.text_content("#pos"), f"{n} / {n}")
        self.assertEqual(erros, [])
        pg.close()

    def test_2_trimestre_e_link_direto(self):
        pg, erros = _abrir(self, Estado(), hash_="#2026-Q2/2")
        self.assertEqual(pg.input_value("#periodo"), "2026-Q2")
        self.assertEqual(pg.text_content("#pos"), "2 / 3")
        pg.select_option("#periodo", "2026-Q3")
        self.assertIn("/ 18", pg.text_content("#pos"))
        self.assertEqual(erros, [])
        pg.close()

    def test_3_moeda_do_nav_breakdown(self):
        idx = [s["id"] for s in _slides()].index("investidores")
        pg, erros = _abrir(self, Estado(), hash_=f"#2026-Q3/{idx + 1}")
        self.assertIn("total em BRL", pg.text_content("#slide"))
        pg.click('#slide .moeda[data-moeda="USD"]')
        self.assertIn("total em USD", pg.text_content("#slide"))
        self.assertEqual(erros, [])
        pg.close()

    def test_4_exporta_pptx_com_um_slide_por_slide(self):
        pg, erros = _abrir(self, Estado())
        with pg.expect_download(timeout=60000) as d:
            pg.click("#pptx")
        z = zipfile.ZipFile(io.BytesIO(pathlib.Path(d.value.path()).read_bytes()))
        slides = [n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
        self.assertEqual(len(slides), len(_slides()))
        self.assertEqual(erros, [])
        pg.close()

    def test_5_sem_deck_publicado_diz_o_que_houve(self):
        pg, erros = _abrir(self, Estado(spec=None))
        self.assertIn("ainda não foi publicado", pg.text_content("#stage"))
        self.assertTrue(pg.is_visible("#btn-atualizar"))
        pg.close()

    def test_6_deck_desconhecido(self):
        pg, _ = _abrir(self, Estado(), deck="outro")
        self.assertIn("Deck desconhecido", pg.text_content("#stage"))
        pg.close()

    def test_7_atualizar_agora_pede_o_deck_certo(self):
        est = Estado()
        pg, erros = _abrir(self, est, deck="board_fo")
        pg.click("#btn-atualizar")
        pg.wait_for_timeout(800)
        self.assertEqual([p.get("painel") for p in est.pedidos], ["board_fo"])
        self.assertIn("pedido enviado", pg.text_content("#reproc-status"))
        pg.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
