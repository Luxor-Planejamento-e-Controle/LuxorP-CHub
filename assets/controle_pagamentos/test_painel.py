"""Testa o painel de Controle de Pagamentos com o supabase-js REAL e a rede interceptada.

Mesma abordagem do test_painel.py do Saldo Bancário: o painel cria o client no primeiro
carregamento e o mantém em cache, então trocar `window.supabase` depois não tem efeito.
Interceptando as requisições, o supabase-js real roda — o que também testa se as chamadas
que escrevemos (storage.download, app_state select/update) produzem as requisições certas.

Roda sem credencial, sem sessão e sem tocar no Supabase de verdade.

Uso: python assets/controle_pagamentos/test_painel.py   (da raiz do repo do hub)
"""

import json
import pathlib
import unittest

AQUI = pathlib.Path(__file__).resolve().parent

# Forma real do que o ETL publica (extrair_dados_modelo_novo.py): meses já batidos.
RESULTADO = {
    "id": "modelo_novo",
    "rotulo": "Modelo novo",
    "fonte": "controle_pagamentos.json",
    "gerado_em": "2026-09-14T08:00:00",
    "meses": [{
        "id": "2026-09", "mes": 9, "ano": 2026, "rotulo": "Setembro 2026",
        "arquivo": "09 Controle de Pagamentos - Setembro 2026.xlsx",
        "atualizado_em": "2026-09-14T08:00", "ref_prazos": "2026-09-14",
        "fixos": [
            {"cod": "000041", "empresa": "EMPRESA UM", "fornecedor": "FORNECEDOR A",
             "obs": "", "ocorrencia": 1, "reajuste": "-", "status": "recebido",
             "valor": 1200.0, "valor_txt": "1.200,00", "venc_dia": 5, "venc_orig": "5"},
            {"cod": "000042", "empresa": "EMPRESA DOIS", "fornecedor": "FORNECEDOR B",
             "obs": "anual (SET)", "ocorrencia": 1, "reajuste": "-",
             "status": "nao_recebido", "valor": None, "valor_txt": "Variável",
             "venc_dia": 10, "venc_orig": "10"},
        ],
        "titulos": {"n": 12, "valor": -34000.0,
                    "situacao": {"recebido": 5, "sem_cadastro": 7}},
        "fora_competencia": [],
    }],
}

# (ano, cod, empresa, contagem) é a chave do batimento. A terceira linha repete a chave
# da primeira de propósito: é o erro que a tela tem de apontar antes de gravar.
CADASTRO = [
    {"ano": 2026, "cod": "000041", "empresa": "EMPRESA UM", "contagem": 1,
     "fornecedor": "FORNECEDOR A", "valor_usual_txt": "1.200,00", "valor_usual": 1200,
     "venc_orig": "5", "obs": "", "reajuste": "-",
     "meses": ["jan", "fev", "mar", "abr", "mai", "jun",
               "jul", "ago", "set", "out", "nov", "dez"],
     "ativo": True, "obs_interna": "",
     "atualizado_em": "2026-08-01T10:00:00", "atualizado_por": "alguem@luxor.com.br"},
    {"ano": 2026, "cod": "000042", "empresa": "EMPRESA DOIS", "contagem": 1,
     "fornecedor": "FORNECEDOR B", "valor_usual_txt": "Variável", "valor_usual": None,
     "venc_orig": "10", "obs": "anual (SET)", "reajuste": "-",
     "meses": ["set"], "ativo": True, "obs_interna": "",
     "atualizado_em": "2026-08-01T10:00:00", "atualizado_por": "alguem@luxor.com.br"},
    {"ano": 2026, "cod": "000043", "empresa": "EMPRESA TRES", "contagem": 1,
     "fornecedor": "FORNECEDOR C (saiu)", "valor_usual_txt": "", "valor_usual": None,
     "venc_orig": "20", "obs": "", "reajuste": "-",
     "meses": ["jan", "fev"], "ativo": False, "obs_interna": "contrato encerrado 03/2026",
     "atualizado_em": "2026-08-01T10:00:00", "atualizado_por": "alguem@luxor.com.br"},
]


def _pagina(cls, resultado, cadastro):
    """Sobe uma página com o estado dado. Cada teste que precisa de estado diferente
    abre a sua — o painel lê tudo no boot, e mexer no estado depois não o recarrega."""
    from playwright.sync_api import sync_playwright

    if not hasattr(cls, "_pw"):
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()

    cls.estado = {"fornecedores": json.loads(json.dumps(cadastro))}
    cls.gravacoes = []
    cls.erros = []
    pg = cls._b.new_page(viewport={"width": 1500, "height": 950})
    pg.on("pageerror", lambda e: cls.erros.append(str(e)))

    def rota(route, request):
        url, metodo = request.url, request.method
        if "/storage/v1/object/" in url:
            if resultado is None:
                return route.fulfill(status=404, body="")
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(resultado))
        if "/rest/v1/app_state" in url and metodo in ("PATCH", "POST"):
            cls.gravacoes.append(json.loads(request.post_data))
            cls.estado = cls.gravacoes[-1]["data"]
            return route.fulfill(status=200, content_type="application/json", body="[]")
        if "/rest/v1/app_state" in url:
            return route.fulfill(status=200,
                                 content_type="application/vnd.pgrst.object+json",
                                 body=json.dumps({"data": cls.estado}))
        return route.continue_()

    pg.route("**/*.supabase.co/**", rota)
    pg.add_init_script("window.HUB = {email:'leonardo.fernandes@luxor.com.br'};")
    pg.goto((AQUI / "index.html").as_uri())
    pg.wait_for_timeout(1300)
    return pg


def _linha(pg, cod):
    """Seletor da linha pelo CÓDIGO. Endereçar por `nth-child` quebra calado: a tabela é
    ordenada por empresa, então a ordem da tela não é a ordem do cadastro."""
    uid = pg.evaluate(
        "cod => { const l = CP_CADASTRO._linhas().find(x => x.cod === cod);"
        "        return l ? String(l.uid) : null; }", cod)
    assert uid, f"não achei a linha do código {cod}"
    return f'tbody tr[data-uid="{uid}"]'


class TestPainelCP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import playwright  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        cls.pg = _pagina(cls, RESULTADO, CADASTRO)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_b"):
            cls._b.close()
            cls._pw.stop()

    # ---------------- painel ----------------

    def test_1_abre_no_painel_com_resultado_publicado(self):
        txt = self.pg.inner_text("body")
        self.assertIn("Setembro 2026", txt)
        self.assertIn("Editar cadastro", txt)
        self.assertNotIn("undefined", txt)

    def test_2_resultado_veio_do_bucket(self):
        est = self.pg.evaluate("() => window.CP_PAINEL.estado()")
        self.assertTrue(est["temPainel"])
        self.assertEqual(est["publicadoEm"], "2026-09-14T08:00:00")
        self.assertEqual(len(est["fornecedores"]), 3)

    # ---------------- tela de cadastro ----------------

    def test_3_botao_abre_o_cadastro(self):
        pg = self.pg
        pg.click("#btCadastro")
        pg.wait_for_timeout(500)
        self.assertIn("Fornecedores fixos", pg.inner_text("body"))
        # o filtro abre em "ativos": o inativo não aparece
        self.assertEqual(pg.locator("tbody tr[data-uid]").count(), 2)

    def test_4_mostra_inativo_com_o_motivo(self):
        pg = self.pg
        pg.click('#cpcMostrar button[data-v="inativos"]')
        pg.wait_for_timeout(400)
        self.assertEqual(pg.locator("tbody tr[data-uid]").count(), 1)
        self.assertEqual(
            pg.input_value('input.cpc[data-campo="obs_interna"]'),
            "contrato encerrado 03/2026",
            "fornecedor que saiu tem o motivo à vista, e não um sumiço sem explicação")
        pg.click('#cpcMostrar button[data-v="todos"]')
        pg.wait_for_timeout(400)
        self.assertEqual(pg.locator("tbody tr[data-uid]").count(), 3)

    def test_5_aponta_chave_repetida_antes_de_gravar(self):
        """A chave (ano+cód+empresa+ocorrência) casa a N-ésima linha do cadastro com o
        N-ésimo título. Repetida, o batimento não sabe qual é qual — e erra calado, que
        é exatamente o modo de falha que a auditoria encontrou na planilha."""
        pg = self.pg
        self.assertEqual(pg.locator(".erro-box").count(), 0, "cadastro limpo, sem alarme")

        # duplica a chave da primeira linha na terceira
        # segura o seletor ANTES: depois de duplicar o código, procurar por "000041"
        # acha duas linhas e `find` devolve a errada
        alvo = _linha(pg, "000043")
        pg.fill(alvo + ' input.cpc[data-campo="cod"]', "000041")
        pg.fill(alvo + ' input.cpc[data-campo="empresa"]', "EMPRESA UM")
        pg.click("#cpcMostrar button[data-v='todos']")   # força re-render
        pg.wait_for_timeout(400)
        self.assertEqual(pg.locator(".erro-box").count(), 1)
        self.assertIn("chave repetida", pg.inner_text(".erro-box"))

        # desfaz
        pg.fill(alvo + ' input.cpc[data-campo="cod"]', "000043")
        pg.fill(alvo + ' input.cpc[data-campo="empresa"]', "EMPRESA TRES")
        pg.click("#cpcMostrar button[data-v='todos']")
        pg.wait_for_timeout(400)
        self.assertEqual(pg.locator(".erro-box").count(), 0)

    def test_6_fichas_de_mes_alternam(self):
        pg = self.pg
        primeira = _linha(pg, "000041") + ' .meses button[data-mes="jan"]'
        self.assertTrue(pg.locator(primeira).evaluate("el => el.classList.contains('on')"))
        pg.click(primeira)
        self.assertFalse(pg.locator(primeira).evaluate("el => el.classList.contains('on')"))
        est = pg.evaluate("() => CP_CADASTRO._linhas().find(l => l.cod === '000041').meses")
        self.assertNotIn("jan", est)
        pg.click(primeira)   # devolve

    def test_7_grava_carimbando_so_o_que_mudou(self):
        pg = self.pg
        pg.fill(_linha(pg, "000041") + ' input.cpc[data-campo="valor_usual_txt"]', "1.350,00")
        pg.wait_for_timeout(200)
        self.assertFalse(pg.locator("#cpcSalvar").is_disabled(),
                         "alterou, o botão tem de habilitar")

        pg.click("#cpcSalvar")
        pg.wait_for_timeout(900)

        self.assertTrue(self.gravacoes, "nada foi gravado em app_state")
        doc = self.gravacoes[-1]["data"]
        self.assertEqual(len(doc["fornecedores"]), 3, "o cadastro inteiro é regravado")

        por_cod = {f["cod"]: f for f in doc["fornecedores"]}
        self.assertEqual(por_cod["000041"]["valor_usual_txt"], "1.350,00")
        self.assertEqual(por_cod["000041"]["atualizado_por"],
                         "leonardo.fernandes@luxor.com.br", "quem mexeu fica registrado")
        self.assertEqual(por_cod["000042"]["atualizado_em"], "2026-08-01T10:00:00",
                         "quem NÃO mudou mantém o carimbo antigo — senão 'atualizado_em' "
                         "não responderia mais quem mexeu em quê")

    def test_8_avisa_que_a_edicao_ainda_nao_entrou_nos_numeros(self):
        """O batimento roda no ETL. Sem este aviso, quem edita o cadastro e não vê o
        número mudar conclui que a tela está quebrada."""
        pg = self.pg
        est = pg.evaluate("() => window.CP_PAINEL.estado()")
        self.assertEqual(est["pendentes"], 1,
                         "um registro foi editado depois da última publicação")
        pg.click("#cpcSair")
        pg.wait_for_timeout(600)
        self.assertIn("ainda não refletida", pg.inner_text("body"))

    def test_9_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")


class TestSemResultadoPublicado(unittest.TestCase):
    """ETL ainda não rodou: o bucket devolve 404. A tela abre no cadastro, que é o que
    dá para fazer — em vez de uma tela de erro que não diz o que fazer."""

    @classmethod
    def setUpClass(cls):
        try:
            import playwright  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        cls.pg = _pagina(cls, None, CADASTRO)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_b"):
            cls._b.close()
            cls._pw.stop()

    def test_abre_no_cadastro(self):
        txt = self.pg.inner_text("body")
        self.assertIn("Fornecedores fixos", txt)
        self.assertNotIn("undefined", txt)
        est = self.pg.evaluate("() => window.CP_PAINEL.estado()")
        self.assertFalse(est["temPainel"])
        self.assertEqual(est["pendentes"], 0, "sem publicação não há o que estar pendente")

    def test_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
