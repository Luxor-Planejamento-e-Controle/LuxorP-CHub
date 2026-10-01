"""Testa o painel do Tarituba no hub com o supabase-js REAL e a rede interceptada.

Mesma abordagem dos painéis de Saldo Bancário e Controle de Pagamentos: nada de
credencial, sessão ou Supabase de verdade — as requisições do supabase-js são atendidas
aqui, o que também confere que o painel pede os arquivos e a função certos.

O payload é SINTÉTICO (nomes e valores inventados): o repositório é público.

Uso: python assets/tarituba/test_painel.py   (da raiz do repo do hub)
"""

import json
import pathlib
import unittest

AQUI = pathlib.Path(__file__).resolve().parent


def _payload():
    """Forma real do que o Azure publica (extrair_dados.montar), com dado inventado."""
    def nat(cod, nome, bloco, orc, real):
        return {"cod": cod, "nome": nome, "id": cod, "bloco": bloco, "na_planilha": True,
                "orc": orc, "real": real, "tem_orc": True, "tem_mov": True}

    z = [0.0] * 12
    rend = nat("13.1.1.01.01", "RENDIMENTOS", "receita", [1000.0] * 12, [1100.0, 900.0] + z[2:])
    sal = nat("13.2.1.01.01", "SALARIOS", "despesa", [-3000.0] * 12, [-3000.0, -3200.0] + z[2:])
    serv = nat("13.2.1.01.02", "SERVICOS", "despesa", [-500.0] * 12, [-400.0, -600.0] + z[2:])
    nats = [rend, sal, serv]

    def soma(bloco, campo):
        return [sum(n[campo][i] for n in nats if n["bloco"] == bloco) for i in range(12)]

    receita, despesa = soma("receita", "real"), soma("despesa", "real")
    orc_r, orc_d = soma("receita", "orc"), soma("despesa", "orc")
    variacao = [receita[i] + despesa[i] for i in range(12)]
    saldo, acc = [], 10000.0
    for v in variacao:
        acc += v
        saldo.append(acc)
    no = lambda tipo, nome, nivel, cod=None: {"tipo": tipo, "lin": 0, "nome": nome,
                                             "nivel": nivel, "cod": cod, "fora_do_bloco": False}
    return {
        "meta": {"titulo": "Fluxo de Caixa — Tarituba", "ano": 2026, "gerado_em": "01/03/2026 09:00",
                 "fontes": {"realizado": "API", "orcado": "orc.xlsx", "saldos": "fluxo.xlsx"}},
        "meses": [{"n": i + 1, "rot": r, "status": "fechado" if i < 2 else "aberto"}
                  for i, r in enumerate(["jan", "fev", "mar", "abr", "mai", "jun",
                                         "jul", "ago", "set", "out", "nov", "dez"])],
        "nat": nats,
        "estrutura": {
            "receitas": [no("grupo", "Receitas", 0), no("grupo", "Receita Financeira", 1),
                         no("natureza", "RENDIMENTOS", 2, "13.1.1.01.01")],
            "despesas": [no("grupo", "Despesas", 0), no("grupo", "Despesas Gerais", 1),
                         no("grupo", "Pessoal", 2), no("natureza", "SALARIOS", 3, "13.2.1.01.01"),
                         no("natureza", "SERVICOS", 2, "13.2.1.01.02")],
        },
        "orc_itens": [],
        "serie": {"receita": receita, "despesa": despesa, "variacao": variacao,
                  "orc_receita": orc_r, "orc_despesa": orc_d,
                  "orc_variacao": [orc_r[i] + orc_d[i] for i in range(12)],
                  "saldo_fim": saldo, "confronto": [None] * 12},
        "saldos": {"inicial": 10000.0,
                   "mensal": [{"mes": i + 1, "corrente": None, "caixa": None, "aplicacao": None,
                               "preenchido": False, "total": None} for i in range(12)]},
        "detalhe": [],
        "avisos": [],
        "qual": {"meses_fechados": 2, "naturezas": 3, "sem_orc_sem_mov": 0,
                 "fora_da_planilha": [], "fora_do_bloco": [], "lancamentos": 0},
    }


class Estado:
    """O que o 'Supabase' devolve, mutável durante o teste."""
    def __init__(self, painel=True):
        self.painel = _payload() if painel else None
        self.card = None            # tarituba.card.json
        self.pedidos = []           # corpos enviados à Edge Function
        self.card_depois = None     # o que o card.json passa a ser depois do pedido


def _abrir(cls, estado, pagina="simples"):
    from playwright.sync_api import sync_playwright

    cls = type(cls)   # chamado com a instância; o navegador é um só para a classe
    if not hasattr(cls, "_pw"):
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
    erros = []
    pg = cls._b.new_page(viewport={"width": 1600, "height": 950})
    pg.on("pageerror", lambda e: erros.append(str(e)))

    def rota(route, request):
        url = request.url
        if "/functions/v1/reprocessar" in url:
            if request.method == "OPTIONS":
                return route.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*",
                                                          "Access-Control-Allow-Headers": "*"})
            estado.pedidos.append(json.loads(request.post_data or "{}"))
            if estado.card_depois is not None:
                estado.card = estado.card_depois
            return route.fulfill(status=202, content_type="application/json",
                                 headers={"Access-Control-Allow-Origin": "*"},
                                 body=json.dumps({"aceito": True}))
        if "/storage/v1/object/" in url:
            if url.split("?")[0].endswith("/tarituba.card.json"):
                doc = estado.card
            elif url.split("?")[0].endswith("/tarituba.json"):
                doc = estado.painel
            else:
                doc = None
            if doc is None:
                return route.fulfill(status=400, content_type="application/json",
                                     body=json.dumps({"statusCode": "404", "error": "not_found",
                                                      "message": "Object not found"}))
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(doc))
        return route.continue_()

    pg.route("**/*.supabase.co/**", rota)
    pg.goto((AQUI / "index.html").as_uri())
    pg.wait_for_timeout(1500)
    if pagina == "simples" and estado.painel is not None:
        pg.click("#nav-pag button:nth-child(2)")
        pg.wait_for_timeout(300)
    return pg, erros


class TestPainelTarituba(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import playwright  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_pw"):
            cls._b.close()
            cls._pw.stop()

    def test_1_abre_com_o_dado_do_bucket(self):
        pg, erros = _abrir(self, Estado(), pagina="resumo")
        self.assertEqual(erros, [])
        self.assertIn("2026", pg.text_content("#sub"))
        self.assertTrue(pg.is_visible("#btn-atualizar"))
        self.assertIn("01/03/2026 09:00", pg.text_content("#chip-fonte-txt"))
        pg.close()

    def test_2_sem_painel_publicado_diz_o_que_houve(self):
        pg, erros = _abrir(self, Estado(painel=False), pagina="resumo")
        self.assertEqual(erros, [])
        self.assertIn("Painel indisponível", pg.text_content("#view"))
        pg.close()

    def test_3_botao_do_card_manda_acao_e_o_mes_da_tela(self):
        """O mês é o SELECIONADO no clique, não o padrão (último fechado)."""
        est = Estado()
        est.card_depois = {"ok": True, "gerado_em": "2026-03-02T10:00:00-03:00",
                           "card_url": "https://trello.com/c/abc123", "lista": "Planilha Janeiro 2026",
                           "card_novo": True, "dados_de": "01/03/2026 09:00", "mes": 1}
        pg, erros = _abrir(self, est)
        self.assertTrue(pg.is_visible("#btn-card-trello"))
        pg.select_option("#sel-mes-simples", "1")
        pg.wait_for_timeout(300)
        pg.click("#btn-card-trello")
        pg.wait_for_timeout(7000)   # o reprocessar.js relê o carimbo a cada 5s
        self.assertEqual(est.pedidos, [{"painel": "tarituba", "acao": "card_trello", "mes": 1}])
        st = pg.text_content("#card-status")
        self.assertIn("Card criado", st)
        self.assertIn("Planilha Janeiro 2026", st)
        self.assertEqual(pg.get_attribute("#card-status a", "href"), "https://trello.com/c/abc123")
        self.assertEqual(erros, [])
        pg.close()

    def test_4_erro_do_pedido_aparece_como_erro(self):
        est = Estado()
        est.card_depois = {"ok": False, "gerado_em": "2026-03-02T10:00:00-03:00", "mes": 2,
                           "erro": "Não existe lista de Fevereiro 2026 no board do Trello."}
        pg, _ = _abrir(self, est)
        pg.click("#btn-card-trello")
        pg.wait_for_timeout(7000)
        self.assertIn("Não existe lista de Fevereiro 2026", pg.text_content("#card-status"))
        self.assertIn("erro", pg.get_attribute("#card-status", "class"))
        self.assertEqual(est.pedidos[0]["mes"], 2)   # sem trocar: o último fechado
        pg.close()

    def test_5_link_que_nao_e_https_nao_vira_link(self):
        """O link vem de um arquivo do bucket: `javascript:` num href seria execução."""
        est = Estado()
        est.card_depois = {"ok": True, "gerado_em": "2026-03-02T10:00:00-03:00", "mes": 2,
                           "card_url": "javascript:alert(1)", "lista": "x", "card_novo": True,
                           "dados_de": "y"}
        pg, _ = _abrir(self, est)
        pg.click("#btn-card-trello")
        pg.wait_for_timeout(7000)
        self.assertIn("Card criado", pg.text_content("#card-status"))
        self.assertEqual(pg.query_selector_all("#card-status a"), [])
        pg.close()

    def test_6_atualizar_agora_republica_sem_acao(self):
        est = Estado()
        pg, _ = _abrir(self, est, pagina="resumo")
        pg.click("#btn-atualizar")
        pg.wait_for_timeout(1500)
        self.assertEqual(est.pedidos, [{"painel": "tarituba"}])
        self.assertIn("10 minutos", pg.text_content("#reproc-status"))
        pg.close()

    def test_7_botao_do_card_nao_vai_para_o_pdf(self):
        """O Exportar PDF imprime a página: botão e status do Trello não podem sair nele."""
        pg, _ = _abrir(self, Estado())
        pg.emulate_media(media="print")
        self.assertFalse(pg.is_visible("#btn-card-trello"))
        self.assertFalse(pg.is_visible("#btn-atualizar"))
        pg.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
