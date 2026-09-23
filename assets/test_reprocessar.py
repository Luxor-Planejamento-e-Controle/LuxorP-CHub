"""Testa o botão "Atualizar agora" nos dois painéis, com a rede interceptada.

O que se prova aqui é o comportamento que ninguém consegue verificar clicando: o que
acontece quando a Edge Function recusa, quando o robô demora, e o que a tela mostra
enquanto espera. Clicar à mão testa só o caminho feliz — e ele é o menos provável de
quebrar.

A chamada à Edge Function sai como POST para /functions/v1/reprocessar; o supabase-js real
monta essa requisição, então interceptá-la também prova que o invoke() está sendo usado
certo.

O QUE A REDE INTERCEPTADA **NÃO** PROVA — e custou uma quebra em produção: interceptar a
rota mata o preflight. O navegador só pergunta "posso mandar estes cabeçalhos?" quando a
requisição sai de verdade, e a resposta vem da função PUBLICADA, não deste código. Por
isso a última classe daqui sai para a rede: é o único jeito de testar o CORS real.

Uso: python assets/test_reprocessar.py   (da raiz do repo do hub)
"""

import json
import pathlib
import re
import unittest
import urllib.error
import urllib.request

AQUI = pathlib.Path(__file__).resolve().parent

FATOS_SB = {
    "meta": {"janela_inicio": "2026-09-23", "janela_fim": "2026-09-30",
             "gerado_em": "22/09/2026 08:00"},
    "a_pagar_por_conta": {"LUXOR INVESTIMENTOS": 1000.0},
    "titulos": [{"conta": "LUXOR INVESTIMENTOS", "fornecedor": "F", "titulo": "1",
                 "emissao": "2026-09-01", "vencimento": "2026-09-24", "valor": 1000.0}],
}

ESTADO_SB = {
    "contas": [{"chave": "LUXOR INVESTIMENTOS", "conta": "Luxor Investimentos - Itau",
                "banco": "ITAU", "colchao": 300.0, "ativa": True, "investimentos": []}],
    "entradas": {"2026-09-23": [{"chave": "LUXOR INVESTIMENTOS", "saldo": 50000.0,
                                 "a_receber": 0, "por": "fulano@luxor.com.br",
                                 "em": "2026-09-23T10:00:00Z"}]},
}


class Base(unittest.TestCase):
    """Sobe a página com o arquivo do bucket sob controle do teste, para o carimbo de
    geração poder mudar no meio — que é o sinal de "o robô terminou"."""

    PAINEL = None
    ARQUIVO = None
    ESTADO = None

    @classmethod
    def setUpClass(cls):
        if cls is Base:
            raise unittest.SkipTest("classe base")
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")

        cls.fatos = json.loads(json.dumps(cls.ARQUIVO))
        cls.estado = json.loads(json.dumps(cls.ESTADO))
        cls.pedidos = []
        cls.resposta_edge = {"status": 202, "corpo": {"aceito": True}}
        cls.erros = []

        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
        cls.pg = cls._b.new_page(viewport={"width": 1280, "height": 900})
        cls.pg.on("pageerror", lambda e: cls.erros.append(str(e)))

        def rota(route, request):
            url = request.url
            if "/functions/v1/reprocessar" in url:
                cls.pedidos.append(json.loads(request.post_data or "{}"))
                r = cls.resposta_edge
                return route.fulfill(status=r["status"], content_type="application/json",
                                     body=json.dumps(r["corpo"], ensure_ascii=False))
            if "/storage/v1/object/" in url:
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps(cls.fatos))
            if "/rest/v1/app_state" in url:
                return route.fulfill(status=200,
                                     content_type="application/vnd.pgrst.object+json",
                                     body=json.dumps({"data": cls.estado,
                                                      "updated_at": "2026-09-22T00:00Z"}))
            return route.continue_()

        cls.pg.route("**/*.supabase.co/**", rota)
        cls.pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
        cls.pg.goto((AQUI / cls.PAINEL / "index.html").as_uri())
        cls.pg.wait_for_timeout(1500)

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def setUp(self):
        """Página nova a cada teste. Um clique deixa o botão esperando o robô por até
        cinco minutos, e o teste seguinte encontraria o botão desabilitado — não por um
        defeito, mas por sujeira do anterior."""
        type(self).pedidos = []
        type(self).resposta_edge = {"status": 202, "corpo": {"aceito": True}}
        type(self).fatos = json.loads(json.dumps(self.ARQUIVO))
        self.pg.goto((AQUI / self.PAINEL / "index.html").as_uri())
        self.pg.wait_for_timeout(1400)
        type(self).pedidos = []          # o boot não pede reprocessamento

    def clicar(self):
        self.pg.click("#btReprocessar")

    def test_1_o_botao_existe(self):
        self.assertEqual(self.pg.locator("#btReprocessar").count(), 1)

    def test_2_manda_o_painel_certo(self):
        """O nome do painel decide o que o Azure roda e o que o hub_can() avalia.
        Trocado, a pessoa reprocessaria o painel do outro — ou tomaria 403 sem entender."""
        self.clicar()
        self.pg.wait_for_timeout(900)
        self.assertEqual(len(self.pedidos), 1)
        self.assertEqual(self.pedidos[0].get("painel"), self.PAINEL)

    def test_3_nao_dispara_duas_vezes(self):
        """Clique repetido enquanto espera não pode virar dois pedidos: cada um é uma
        rodada de chamadas à API do Bimer."""
        self.clicar()
        self.pg.wait_for_timeout(200)
        for _ in range(4):
            self.pg.locator("#btReprocessar").dispatch_event("click")
        self.pg.wait_for_timeout(800)
        self.assertEqual(len(self.pedidos), 1)

    def test_4_botao_desabilita_e_avisa_que_esta_esperando(self):
        self.clicar()
        self.pg.wait_for_timeout(900)
        self.assertTrue(self.pg.locator("#btReprocessar").is_disabled())
        self.assertIn("aguardando", self.pg.inner_text("#reprocStatus").lower())

    def test_5_erro_da_edge_function_chega_legivel(self):
        """A mensagem útil vem no CORPO do erro; sem desembrulhar, a tela diria
        'non-2xx status code', que não ajuda ninguém."""
        type(self).resposta_edge = {"status": 403,
                                    "corpo": {"erro": "sem acesso a este painel"}}
        self.clicar()
        self.pg.wait_for_timeout(1200)
        txt = self.pg.inner_text("#reprocStatus")
        self.assertIn("sem acesso a este painel", txt)
        self.assertFalse(self.pg.locator("#btReprocessar").is_disabled(),
                         "depois do erro dá para tentar de novo")

    def test_6_quando_o_carimbo_muda_a_tela_recarrega(self):
        """O fim do trabalho não é a resposta do pedido — é o arquivo publicado mudar."""
        self.clicar()
        self.pg.wait_for_timeout(600)

        novo = json.loads(json.dumps(self.ARQUIVO))
        self.marcar_novo(novo)
        type(self).fatos = novo

        self.pg.wait_for_timeout(7000)          # o polling é de 5s
        self.assertIn("atualizado", self.pg.inner_text("#reprocStatus").lower())
        self.assertTrue(self.tela_mostra_o_novo(), "a tela não redesenhou com o dado novo")

    def test_7_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")

    def test_8_um_unico_client_de_autenticacao(self):
        """Dois GoTrueClient no mesmo contexto disputam o storage de sessão e o lock de
        renovação de token. Quando esse lock trava, o fetch falha ANTES de sair e o
        supabase-js reporta "Failed to send a request to the Edge Function" — erro de rede
        para um problema que não é de rede.

        Visto em produção: aqui passava e no hub falhava, porque SEM SESSÃO não há refresh
        para disputar. O teste não consegue criar sessão real, mas consegue provar a causa
        — que o botão reusa o client do painel em vez de criar o seu.
        """
        avisos = []
        self.pg.on("console", lambda m: avisos.append(m.text)
                   if "GoTrueClient" in m.text else None)
        # o segundo client só nasceria NO CLIQUE, não no carregamento — checar só o boot
        # deixava o teste passar com o defeito presente
        self.clicar()
        self.pg.wait_for_timeout(1500)
        duplicados = [a for a in avisos if "Multiple GoTrueClient" in a]
        self.assertEqual(duplicados, [],
                         "mais de um client de autenticação: o botão criou o seu em vez "
                         "de reusar o do painel")


class TestSaldoBancario(Base):
    PAINEL = "saldo_bancario"
    ARQUIVO = FATOS_SB
    ESTADO = ESTADO_SB

    def marcar_novo(self, d):
        d["meta"]["gerado_em"] = "22/09/2026 15:42"
        d["a_pagar_por_conta"]["LUXOR INVESTIMENTOS"] = 4321.0
        d["titulos"][0]["valor"] = 4321.0

    def tela_mostra_o_novo(self):
        return "4.321" in self.pg.inner_text("body")


PAINEL_CP = {
    "id": "modelo_novo", "rotulo": "Modelo novo",
    "fonte": "controle_pagamentos.json",
    "gerado_em": "2026-09-21T08:30",
    "meses": [{
        "id": "2026-09", "mes": 9, "ano": 2026, "rotulo": "Setembro 2026",
        "arquivo": "API do Bimer + cadastro do hub",
        "atualizado_em": "2026-09-21T08:30", "ref_prazos": "2026-09-21",
        "fixos": [{"fornecedor": "FORNECEDOR A", "cod": "1001", "empresa": "LUXOR",
                   "valor_txt": "R$ 1.234,00", "valor": 1234.0, "venc_orig": "10",
                   "venc_dia": 10, "status": "nao_recebido", "obs": None,
                   "reajuste": None, "ocorrencia": 1}],
        "titulos": {"n": 7, "valor": 9999.0, "situacao": {"recebido": 7}},
        "fora_competencia": [],
    }],
}

ESTADO_CP = {"fornecedores": [
    {"cod": "1001", "empresa": "LUXOR", "fornecedor": "FORNECEDOR A", "ano": 2026,
     "contagem": 1, "meses": ["set"], "valor_usual": 1234.0,
     "valor_usual_txt": "R$ 1.234,00", "venc_orig": "10", "obs": None,
     "reajuste": None, "ativo": True}]}


class TestControlePagamentos(Base):
    PAINEL = "controle_pagamentos"
    ARQUIVO = PAINEL_CP
    ESTADO = ESTADO_CP

    def marcar_novo(self, d):
        d["gerado_em"] = "2026-09-21T15:42"
        d["meses"][0]["atualizado_em"] = "2026-09-21T15:42"
        d["meses"][0]["fixos"][0]["status"] = "recebido"

    def tela_mostra_o_novo(self):
        # o carimbo do arquivo aparece no rodapé; é o sinal mais direto de que a tela
        # foi redesenhada com o conteúdo novo, e não só com o estado antigo em memória
        return "15:42" in self.pg.inner_text("body")


class TestCorsDaFuncaoPublicada(unittest.TestCase):
    """O preflight REAL, contra a Edge Function que está no ar.

    Regressão de uma quebra em produção: o botão respondia "o pedido não chegou ao
    servidor" porque o preflight autorizava só `authorization, content-type, apikey` — e o
    supabase-js manda `x-client-info` em toda requisição. O navegador pede permissão, não
    recebe, e bloqueia a chamada ANTES de sair; o supabase-js reporta isso como erro de
    envio.

    Nenhum teste pegava: os de navegador interceptam a rota, e rota interceptada não faz
    preflight. Só sai daqui para a rede.

    Os cabeçalhos testados não são uma lista escrita à mão — são os que o supabase-js
    desta página de fato envia, capturados do bundle. Lista à mão envelheceria junto com
    a biblioteca, que é exatamente como o defeito nasceu.
    """

    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")

        cfg = (AQUI / "saldo_bancario" / "config.js").read_text(encoding="utf-8")
        cls.url = re.search(r'SUPABASE_URL\s*=\s*"([^"]+)"', cfg).group(1).rstrip("/")

        # Os cabeçalhos vêm de uma chamada de VERDADE do supabase-js, capturada na saída.
        # Lê-los do bundle minificado seria adivinhação — foi o que falhou primeiro, com
        # `X-Client-Info` escrito em maiúsculas e um regex de minúsculas.
        capturados = {}
        estado = {"contas": ESTADO_SB["contas"], "entradas": {}, "provisoes": {}}

        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={"width": 1280, "height": 900})

            def rota(route, request):
                u = request.url
                if "/functions/v1/" in u:
                    capturados.update(request.all_headers())
                    return route.fulfill(status=202, content_type="application/json",
                                         body='{"aceito":true}')
                if "/storage/v1/object/" in u:
                    return route.fulfill(status=200, content_type="application/json",
                                         body=json.dumps(FATOS_SB))
                if "/rest/v1/app_state" in u and request.method in ("PATCH", "POST"):
                    estado.update(json.loads(request.post_data)["data"])
                    return route.fulfill(status=200, content_type="application/json",
                                         body='[{"id":"x","updated_at":"y"}]')
                if "/rest/v1/app_state" in u:
                    return route.fulfill(
                        status=200,
                        content_type="application/vnd.pgrst.object+json",
                        body=json.dumps({"data": estado, "updated_at": "y"}))
                return route.continue_()

            pg.route("**/*.supabase.co/**", rota)
            pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
            pg.goto((AQUI / "saldo_bancario" / "index.html").as_uri())
            pg.wait_for_timeout(1400)
            campos = pg.locator("input.sbf[data-campo=saldo]")
            for i in range(campos.count()):
                campos.nth(i).fill("100.000,00")
            pg.click("#sbfSalvar")
            pg.wait_for_timeout(1600)
            pg.click("#btReprocessar")
            pg.wait_for_timeout(1200)
            b.close()

        # o navegador só pede permissão para os que não são "simples"
        simples = {"accept", "accept-language", "content-language", "referer",
                   "user-agent", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest",
                   "origin", "host", "connection", "accept-encoding", "sec-ch-ua",
                   "sec-ch-ua-mobile", "sec-ch-ua-platform", "content-length"}
        cls.cabecalhos = sorted(k for k in capturados
                                if k.lower() not in simples and not k.startswith(":"))

    def _preflight(self, pedidos):
        req = urllib.request.Request(
            f"{self.url}/functions/v1/reprocessar", method="OPTIONS")
        req.add_header("Origin", "https://lxplanejamentoecontrole.netlify.app")
        req.add_header("Access-Control-Request-Method", "POST")
        req.add_header("Access-Control-Request-Headers", ", ".join(pedidos))
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.status, {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.URLError as e:
            raise unittest.SkipTest(f"sem rede para falar com o Supabase: {e}")

    def test_1_a_lib_manda_mais_que_o_obvio(self):
        """Se a captura trouxesse só os três óbvios, o teste abaixo não provaria nada —
        e o defeito real era justamente um quarto cabeçalho."""
        self.assertIn("x-client-info", self.cabecalhos,
                      f"não capturei os cabeçalhos da lib: {self.cabecalhos}")

    def test_2_o_preflight_autoriza_o_que_a_lib_envia(self):
        status, h = self._preflight(self.cabecalhos)
        self.assertEqual(status, 200)

        permitidos = {c.strip().lower()
                      for c in h.get("access-control-allow-headers", "").split(",")}
        faltando = [c for c in self.cabecalhos if c not in permitidos]
        self.assertEqual(faltando, [], f"o navegador bloquearia por causa de: {faltando}")
        self.assertIn(h.get("access-control-allow-origin"),
                      ("*", "https://lxplanejamentoecontrole.netlify.app"))

    def test_3_metodo_post_liberado(self):
        _s, h = self._preflight(["authorization", "content-type"])
        self.assertIn("POST", h.get("access-control-allow-methods", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
