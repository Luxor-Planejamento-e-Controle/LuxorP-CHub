"""Testa a tela de naturezas do Haras com o supabase-js REAL e a rede interceptada.

Mesma abordagem do test_painel.py do Controle de Pagamentos: o supabase-js real roda, e
o que se confere é a requisição que ele produz (o UPDATE com a guarda de versão, o
download do bucket) e o que a tela faz com a resposta. Roda sem credencial e sem tocar no
Supabase de verdade. Cada teste abre a SUA página: a tela lê tudo no boot.

Uso: python assets/haras_naturezas/test_painel.py   (da raiz do repo do hub)
"""

import copy
import json
import pathlib
import unittest
import urllib.parse

AQUI = pathlib.Path(__file__).resolve().parent

SAN = ["Custos e Despesas", "Sanidade"]
INV = ["Investimentos", "Compra"]
STAMP = {"atualizado_em": "2026-08-01T10:00:00", "atualizado_por": "alguem@luxor.com.br"}

DOC = {
    "versao": 1,
    "naturezas": [
        {"ordem": 10, "cod": "10.1", "alt": "", "nome": "Vacina", "resp": "Diogo",
         "bimer": [101], "path": SAN, **STAMP},
        {"ordem": 20, "cod": "10.2", "alt": "", "nome": "Exame", "resp": "Diogo",
         "bimer": [102], "path": SAN, **STAMP},
        {"ordem": 30, "cod": "20.1", "alt": "", "nome": "Compra de egua", "resp": "Ana",
         "bimer": [201], "path": INV, **STAMP},
    ],
    "ignoradas": [{"bimer": 900, "nome": "APORTE DE SOCIOS", **STAMP}],
}

PENDENTES = {
    "gerado_em": "2026-10-13T08:30:00",
    "pendentes": [
        {"bimer": 1880, "nome": "MATERIAL DE REPRODUÇÃO", "qtd": 3, "valor": 1181.58, "meses": [9]},
        {"bimer": 1881, "nome": "OUTRA NATUREZA NOVA", "qtd": 1, "valor": 10.0, "meses": [10]},
    ],
}

V0 = "2026-09-01T00:00:00+00:00"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import playwright  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        from playwright.sync_api import sync_playwright
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def abrir(self, doc=DOC, pendentes=PENDENTES, largura=1500):
        self.estado = copy.deepcopy(doc)
        self.versao = V0
        self.gravacoes = []
        self.erros = []
        self.pg = self._b.new_page(viewport={"width": largura, "height": 950})
        self.addCleanup(self.pg.close)
        self.pg.on("pageerror", lambda e: self.erros.append(str(e)))
        # um só tratador de diálogo (dois derrubam o Playwright); `prompt` responde o texto
        self.resposta_dialogo = None
        self.pg.on("dialog", lambda d: d.accept(self.resposta_dialogo)
                   if d.type == "prompt" else d.accept())

        def rota(route, request):
            url, metodo = request.url, request.method
            if "/storage/v1/object/" in url:
                if pendentes is None:
                    return route.fulfill(status=404, body="")
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps(pendentes))
            if "/rest/v1/app_state" in url and metodo in ("PATCH", "POST"):
                pedida = None
                if "updated_at=eq." in url:
                    pedida = urllib.parse.unquote(url.split("updated_at=eq.")[1].split("&")[0])
                # versão vencida: nenhuma linha casa e o PostgREST devolve lista vazia
                if pedida is not None and pedida != self.versao:
                    return route.fulfill(status=200, content_type="application/json", body="[]")
                corpo = json.loads(request.post_data)
                self.gravacoes.append(corpo)
                self.estado = corpo["data"]
                self.versao = corpo.get("updated_at") or self.versao
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps([{"id": "haras_naturezas",
                                                       "updated_at": self.versao}]))
            if "/rest/v1/app_state" in url:
                return route.fulfill(status=200,
                                     content_type="application/vnd.pgrst.object+json",
                                     body=json.dumps({"data": self.estado,
                                                      "updated_at": self.versao}))
            return route.continue_()

        self.pg.route("**/*.supabase.co/**", rota)
        self.pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
        self.pg.goto((AQUI / "index.html").as_uri())
        self.pg.wait_for_selector("#hnSalvar, .erro-box", timeout=5000)
        return self.pg

    def tearDown(self):
        self.assertEqual(self.erros, [], "erro de JavaScript na página")

    # ---- atalhos ----
    def linha(self, cod):
        """Seletor da linha pelo CÓDIGO: a ordem na tela não é a do cadastro."""
        uid = self.pg.evaluate(
            "cod => { const n = HN_CADASTRO._nats().find(x => x.cod === cod);"
            "         return n ? String(n.uid) : null; }", cod)
        self.assertTrue(uid, f"não achei a natureza {cod}")
        return f'table.cadastro tr[data-uid="{uid}"]'

    def ordem_na_tela(self):
        return self.pg.eval_on_selector_all(
            'table.cadastro tr[data-uid] input[data-campo="cod"]', "els => els.map(e => e.value)")

    def salvar(self):
        self.pg.click("#hnSalvar")
        self.pg.wait_for_function(
            "() => /gravado|não foi possível/.test(document.getElementById('hnStatus').textContent)")
        return self.pg.inner_text("#hnStatus")

    def gravado(self):
        self.assertTrue(self.gravacoes, "nada foi gravado")
        return self.gravacoes[-1]["data"]

    def preencher_nova(self, cod, resp, grupo_valor):
        self.pg.fill('tr[data-uid] input[data-campo="cod"] >> nth=-1', cod)  # a nova é a última (sem grupo)
        sel = 'select[data-campo="grupo"] >> nth=-1'
        self.pg.select_option(sel, value=grupo_valor)
        self.pg.fill(f'{self.linha(cod)} input[data-campo="resp"]', resp)


class TestAbertura(Base):
    def test_abre_com_naturezas_agrupadas(self):
        pg = self.abrir()
        txt = pg.inner_text("body")
        self.assertIn("3 naturezas no Controle", txt)
        self.assertEqual(self.ordem_na_tela(), ["10.1", "10.2", "20.1"])
        grupos = pg.eval_on_selector_all("tr.grupo td", "els => els.map(e => e.textContent)")
        self.assertEqual(len(grupos), 2)
        self.assertIn("Custos e Despesas › Sanidade", grupos[0])
        self.assertNotIn("undefined", txt)
        self.assertTrue(pg.is_disabled("#hnSalvar"), "nada alterado, nada a gravar")

    def test_documento_vazio_abre_sem_erro(self):
        """O insert inicial grava '{}': a tela tem de abrir, e não quebrar."""
        pg = self.abrir(doc={}, pendentes=None)
        self.assertIn("0 naturezas no Controle", pg.inner_text("body"))
        self.assertEqual(self.ordem_na_tela(), [])

    def test_sem_pendentes_publicados_a_tela_funciona_e_diz_por_que(self):
        pg = self.abrir(pendentes=None)
        self.assertIn("ainda não foi publicada", pg.inner_text("body"))
        self.assertEqual(self.ordem_na_tela(), ["10.1", "10.2", "20.1"])

    def test_pendentes_mostram_o_dinheiro(self):
        pg = self.abrir()
        txt = pg.inner_text("body")
        self.assertIn("MATERIAL DE REPRODUÇÃO", txt)
        self.assertIn("R$ 1.181,58", txt)
        self.assertEqual(pg.locator("tr[data-pend]").count(), 2)

    def test_sem_rolagem_horizontal_da_pagina_no_celular(self):
        pg = self.abrir(largura=390)
        self.assertLessEqual(pg.evaluate("document.documentElement.scrollWidth"), 390)


class TestPendentes(Base):
    def test_fora_do_escopo_vai_para_ignoradas_e_grava(self):
        pg = self.abrir()
        pg.click('tr[data-pend="1881"] [data-pa="fora"]')
        self.assertEqual(pg.locator("tr[data-pend]").count(), 1, "decidida, sai da lista na hora")
        self.assertFalse(pg.is_disabled("#hnSalvar"))
        self.assertIn("gravado", self.salvar())
        ign = {g["bimer"]: g for g in self.gravado()["ignoradas"]}
        self.assertEqual(set(ign), {900, 1881})
        self.assertEqual(ign[1881]["atualizado_por"], "fulano@luxor.com.br")
        self.assertEqual(ign[900]["atualizado_por"], "alguem@luxor.com.br", "a antiga não é recarimbada")

    def test_incluir_no_controle_exige_cod_resp_e_grupo(self):
        pg = self.abrir()
        pg.click('tr[data-pend="1880"] [data-pa="incluir"]')
        self.assertEqual(pg.locator("tr[data-pend]").count(), 1)
        # nasce com o nome e o código do Bimer, mas sem cód/resp/grupo: não pode gravar
        self.assertTrue(pg.is_disabled("#hnSalvar"))
        erros = pg.inner_text("#hnProbs")
        for esperado in ("`cod` vazio", "`resp` vazio", "sem grupo"):
            self.assertIn(esperado, erros)
        self.assertEqual(pg.input_value('tr[data-uid] input[data-campo="nome"] >> nth=-1'),
                         "MATERIAL DE REPRODUÇÃO")
        self.assertEqual(pg.input_value('tr[data-uid] input[data-campo="bimer"] >> nth=-1'), "1880")

    def test_incluir_completo_entra_no_fim_do_grupo_e_grava(self):
        pg = self.abrir()
        pg.click('tr[data-pend="1880"] [data-pa="incluir"]')
        self.preencher_nova("10.4.2.03.21", "Diogo", " › ".join(SAN))
        self.assertFalse(pg.is_disabled("#hnSalvar"))
        self.assertEqual(pg.inner_text("#hnProbs"), "", "problemas resolvidos somem sem recarregar")
        pg.click("#hnSalvar")
        pg.wait_for_function("() => /gravado/.test(document.getElementById('hnStatus').textContent)")
        d = self.gravado()
        novo = next(n for n in d["naturezas"] if n["cod"] == "10.4.2.03.21")
        self.assertEqual(novo["bimer"], [1880])
        self.assertEqual(novo["path"], SAN)
        self.assertEqual(novo["atualizado_por"], "fulano@luxor.com.br")
        # fim do grupo Sanidade, ANTES de Investimentos: o grupo continua num bloco só
        ordem = [n["cod"] for n in sorted(d["naturezas"], key=lambda n: n["ordem"])]
        self.assertEqual(ordem, ["10.1", "10.2", "10.4.2.03.21", "20.1"])
        self.assertEqual(len({n["ordem"] for n in d["naturezas"]}), 4, "ordens distintas")
        # as que ninguém tocou mantêm o carimbo antigo
        velho = next(n for n in d["naturezas"] if n["cod"] == "20.1")
        self.assertEqual(velho["atualizado_por"], "alguem@luxor.com.br")
        self.assertEqual(velho["ordem"], 30, "quem não mudou de lugar não é renumerado")

    def test_reavaliar_ignorada_devolve_a_pendencia(self):
        """Tirar de 'fora do escopo' não apaga a decisão em silêncio: o código volta a ser
        pendente, se o Bimer ainda o traz."""
        pend = copy.deepcopy(PENDENTES)
        pend["pendentes"].append({"bimer": 900, "nome": "APORTE DE SOCIOS", "qtd": 2,
                                  "valor": 500.0, "meses": [8]})
        pg = self.abrir(pendentes=pend)
        self.assertEqual(pg.locator("tr[data-pend]").count(), 2, "900 já está ignorada")
        pg.click('summary:has-text("Fora do escopo")')
        pg.click('tr[data-ign="900"] [data-ia="reavaliar"]')
        self.assertEqual(pg.locator("tr[data-pend]").count(), 3)
        self.assertFalse(pg.is_disabled("#hnSalvar"))


class TestEdicao(Base):
    def test_so_o_que_mudou_e_carimbado(self):
        pg = self.abrir()
        pg.fill(f'{self.linha("10.2")} input[data-campo="nome"]', "Exame de sangue")
        self.assertIn("gravado", self.salvar())
        por_cod = {n["cod"]: n for n in self.gravado()["naturezas"]}
        self.assertEqual(por_cod["10.2"]["atualizado_por"], "fulano@luxor.com.br")
        self.assertEqual(por_cod["10.1"]["atualizado_em"], "2026-08-01T10:00:00")
        self.assertEqual(por_cod["20.1"]["atualizado_por"], "alguem@luxor.com.br")

    def test_gravacao_preserva_chaves_desconhecidas_do_documento(self):
        doc = copy.deepcopy(DOC)
        doc["outra_coisa"] = {"x": 1}
        self.abrir(doc=doc)
        self.pg.fill(f'{self.linha("10.2")} input[data-campo="resp"]', "Ana")
        self.salvar()
        self.assertEqual(self.gravado()["outra_coisa"], {"x": 1})

    def test_mover_troca_so_dentro_do_grupo(self):
        pg = self.abrir()
        # 10.1 é o primeiro do grupo: não sobe; 10.2 é o último: não desce, e NÃO atravessa
        # para o grupo de baixo (racharia o grupo em dois blocos)
        self.assertTrue(pg.is_disabled(f'{self.linha("10.1")} [data-mv="-1"]'))
        self.assertTrue(pg.is_disabled(f'{self.linha("10.2")} [data-mv="1"]'))
        self.assertTrue(pg.is_disabled(f'{self.linha("20.1")} [data-mv="-1"]'))
        pg.click(f'{self.linha("10.2")} [data-mv="-1"]')
        self.assertEqual(self.ordem_na_tela(), ["10.2", "10.1", "20.1"])
        self.salvar()
        por_cod = {n["cod"]: n for n in self.gravado()["naturezas"]}
        self.assertEqual((por_cod["10.2"]["ordem"], por_cod["10.1"]["ordem"]), (10, 20))
        self.assertEqual(por_cod["20.1"]["atualizado_por"], "alguem@luxor.com.br",
                         "mover duas não carimba a terceira")

    def test_trocar_de_grupo_leva_para_o_fim_do_destino(self):
        pg = self.abrir()
        pg.select_option(f'{self.linha("10.1")} select[data-campo="grupo"]', value=" › ".join(INV))
        self.assertEqual(self.ordem_na_tela(), ["10.2", "20.1", "10.1"])
        grupos = pg.eval_on_selector_all("tr.grupo td", "els => els.map(e => e.textContent)")
        self.assertEqual(len(grupos), 2, "cada grupo continua em UM bloco")

    def test_novo_grupo_por_prompt(self):
        pg = self.abrir()
        self.resposta_dialogo = "Custos e Despesas > Pista"
        pg.select_option(f'{self.linha("10.1")} select[data-campo="grupo"]', value="__novo__")
        self.salvar()
        por_cod = {n["cod"]: n for n in self.gravado()["naturezas"]}
        self.assertEqual(por_cod["10.1"]["path"], ["Custos e Despesas", "Pista"])

    def test_remover_natureza(self):
        pg = self.abrir()
        pg.click(f'{self.linha("10.2")} .btn-lixo')
        self.assertEqual(self.ordem_na_tela(), ["10.1", "20.1"])
        self.salvar()
        self.assertEqual([n["cod"] for n in self.gravado()["naturezas"]], ["10.1", "20.1"])

    def test_filtro_desliga_mover(self):
        pg = self.abrir()
        pg.fill("#hnBusca", "vacina")
        pg.wait_for_timeout(500)
        self.assertEqual(self.ordem_na_tela(), ["10.1"])
        self.assertEqual(pg.locator(".btn-mv:not([disabled])").count(), 0)

    def test_alterar_e_desfazer_nao_acende_o_gravar(self):
        pg = self.abrir()
        campo = f'{self.linha("10.1")} input[data-campo="nome"]'
        pg.fill(campo, "outra")
        self.assertFalse(pg.is_disabled("#hnSalvar"))
        pg.fill(campo, "Vacina")
        self.assertTrue(pg.is_disabled("#hnSalvar"))


class TestValidacao(Base):
    def test_bimer_nao_inteiro_bloqueia_e_aponta_o_campo(self):
        pg = self.abrir()
        campo = f'{self.linha("10.1")} input[data-campo="bimer"]'
        pg.fill(campo, "101, 13a9")
        self.assertTrue(pg.is_disabled("#hnSalvar"))
        self.assertIn("13a9", pg.inner_text("#hnProbs"))
        self.assertIn("ruim", pg.get_attribute(campo, "class"))
        pg.fill(campo, "101, 1363")
        self.assertFalse(pg.is_disabled("#hnSalvar"))
        self.assertEqual(pg.inner_text("#hnProbs"), "")
        self.salvar()
        self.assertEqual({n["cod"]: n for n in self.gravado()["naturezas"]}["10.1"]["bimer"],
                         [101, 1363])

    def test_codigo_do_bimer_repetido_bloqueia(self):
        pg = self.abrir()
        pg.fill(f'{self.linha("10.2")} input[data-campo="bimer"]', "101")
        self.assertTrue(pg.is_disabled("#hnSalvar"))
        self.assertIn("código do Bimer — repetido", pg.inner_text("#hnProbs"))

    def test_codigo_no_controle_e_nas_ignoradas_bloqueia(self):
        pg = self.abrir()
        pg.fill(f'{self.linha("10.2")} input[data-campo="bimer"]', "900")
        self.assertTrue(pg.is_disabled("#hnSalvar"))
        self.assertIn("está no Controle E em ignoradas", pg.inner_text("#hnProbs"))

    def test_classificacao_repetida_bloqueia(self):
        pg = self.abrir()
        pg.fill(f'{self.linha("10.2")} input[data-campo="cod"]', "10.1")
        self.assertTrue(pg.is_disabled("#hnSalvar"))
        self.assertIn("classificação — repetido", pg.inner_text("#hnProbs"))


class TestConcorrencia(Base):
    def test_outra_pessoa_gravou_nada_e_sobrescrito(self):
        pg = self.abrir()
        pg.fill(f'{self.linha("10.1")} input[data-campo="nome"]', "meu ajuste")
        # alguém grava depois que esta tela carregou
        self.versao = "2026-09-02T00:00:00+00:00"
        status = self.salvar()
        self.assertIn("outra pessoa gravou", status)
        self.assertEqual(self.gravacoes, [], "a guarda de versão impediu a gravação")
        self.assertFalse(pg.is_disabled("#hnSalvar"), "a edição não se perde: dá para tentar de novo")

    def test_segunda_gravacao_na_mesma_tela_funciona(self):
        """A versão passa a ser a devolvida pelo banco; senão a 2ª gravação falharia sozinha."""
        pg = self.abrir()
        pg.fill(f'{self.linha("10.1")} input[data-campo="nome"]', "um")
        self.assertIn("gravado", self.salvar())
        pg.fill(f'{self.linha("10.1")} input[data-campo="nome"]', "dois")
        self.assertIn("gravado", self.salvar())
        self.assertEqual(len(self.gravacoes), 2)


class TestRegrasPuras(Base):
    """`hn_dados.js` sem rede: as contas de ordem, que são as que racham grupo se erradas."""

    def setUp(self):
        self.abrir(doc={}, pendentes=None)

    def ev(self, js):
        return self.pg.evaluate(js)

    def test_ordem_apos_cabe_no_vao(self):
        self.assertEqual(self.ev("HN_DADOS.ordemApos([{ordem:10},{ordem:20}], 10)"), 15)
        self.assertEqual(self.ev("HN_DADOS.ordemApos([{ordem:10},{ordem:11}], 10)"), None)
        self.assertEqual(self.ev("HN_DADOS.ordemApos([{ordem:10}], 10)"), 20)

    def test_fim_do_grupo_renumera_quando_nao_cabe(self):
        js = """() => {
          const g = ['G'], h = ['H'];
          const nats = [{ordem:10,path:g},{ordem:11,path:h},{ordem:12,path:h}];
          const novo = {ordem:99, path:[]};
          nats.push(novo);
          const o = HN_DADOS.ordemNoFimDoGrupo(nats, g, novo);
          novo.ordem = o; novo.path = g;
          return HN_DADOS.porOrdem(nats).map(n => n.path[0]);
        }"""
        self.assertEqual(self.ev(js), ["G", "G", "H", "H"])

    def test_ler_bimer_nao_descarta_lixo(self):
        r = self.ev("HN_DADOS.lerBimer('1339, 13a9;1363  x')")
        self.assertEqual(r["ints"], [1339, 1363])
        self.assertEqual(r["invalidos"], ["13a9", "x"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
