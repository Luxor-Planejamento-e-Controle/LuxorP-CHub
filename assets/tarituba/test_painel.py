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
import urllib.parse

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
        self.painel_depois = None   # o que o tarituba.json passa a ser depois do "Atualizar agora"
        self.cadastro = {}          # app_state 'tarituba' (o cadastro de naturezas)
        self.versao = "2026-10-01T00:00:00+00:00"
        self.gravacoes = []
        self.conflito = False       # outra pessoa gravou no meio do caminho


def _com_saldos(payload, pendente=1, planilha=None):
    """Payload com saldo na planilha em todos os meses menos `pendente` (1-12).

    Janeiro de propósito: é o único mês que está encerrado em qualquer data em que o
    teste rode (o painel decide "mês encerrado" pelo relógio de agora). `planilha` troca
    os valores de algum mês: {mes: (corrente, aplicacao, caixa)}."""
    planilha = planilha or {}
    for reg in payload["saldos"]["mensal"]:
        m = reg["mes"]
        if m == pendente:
            continue
        c, a, x = planilha.get(m, (1000.0, 2000.0, 100.0))
        reg.update(corrente=c, aplicacao=a, caixa=x, preenchido=True,
                   total=round(c + a + x, 2))
    return payload


def _abrir(cls, estado, pagina="simples", locais=None):
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
            corpo = json.loads(request.post_data or "{}")
            estado.pedidos.append(corpo)
            if "acao" in corpo and estado.card_depois is not None:
                estado.card = estado.card_depois
            if "acao" not in corpo and estado.painel_depois is not None:
                estado.painel = estado.painel_depois
            return route.fulfill(status=202, content_type="application/json",
                                 headers={"Access-Control-Allow-Origin": "*"},
                                 body=json.dumps({"aceito": True}))
        if "/rest/v1/app_state" in url:
            if request.method in ("PATCH", "POST"):
                # guarda de concorrência: o UPDATE leva `updated_at=eq.<versão lida>`; versão
                # vencida não casa linha nenhuma e o PostgREST devolve lista vazia
                pedida = None
                if "updated_at=eq." in url:
                    pedida = urllib.parse.unquote(url.split("updated_at=eq.")[1].split("&")[0])
                if estado.conflito or (pedida is not None and pedida != estado.versao):
                    return route.fulfill(status=200, content_type="application/json", body="[]")
                corpo = json.loads(request.post_data)
                estado.gravacoes.append(corpo)
                estado.cadastro = corpo["data"]
                estado.versao = corpo.get("updated_at") or estado.versao
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps([{"id": "tarituba", "updated_at": estado.versao}]))
            return route.fulfill(status=200, content_type="application/vnd.pgrst.object+json",
                                 body=json.dumps({"data": estado.cadastro, "updated_at": estado.versao}))
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
    if locais is not None:
        # saldo já digitado no navegador; só na 1ª carga, para recarregar não desfazer
        pg.add_init_script(
            "if (!sessionStorage.getItem('semeado')) {"
            f" localStorage.setItem('tarituba.saldos.2026', {json.dumps(json.dumps(locais))});"
            " sessionStorage.setItem('semeado', '1'); }")
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

    def test_8_primeira_publicacao_pela_tela(self):
        """Painel NUNCA publicado: o "Atualizar agora" tem de funcionar mesmo assim — é ele
        que faz a primeira publicação. Bug do primeiro uso (02/10/2026): o botão só era
        ligado depois do dado carregar, então aparecia e não fazia nada."""
        est = Estado(painel=False)
        est.painel_depois = _payload()
        pg, erros = _abrir(self, est, pagina="resumo")
        antes = pg.text_content("#view")   # a página recarrega depois do clique
        pg.click("#btn-atualizar")
        pg.wait_for_timeout(9000)   # 5s até reler o carimbo + recarregar a página
        # a primeira a falhar no código antigo: o clique não mandava pedido nenhum
        self.assertEqual(est.pedidos, [{"painel": "tarituba"}])
        self.assertIn("2026", pg.text_content("#sub"))
        self.assertNotIn("Painel indisponível", pg.text_content("#view"))
        self.assertIn("Painel indisponível", antes)
        self.assertIn("Atualizar agora", antes)   # a mensagem aponta para o botão
        self.assertEqual(erros, [])
        pg.close()

    def test_7_botao_do_card_nao_vai_para_o_pdf(self):
        """O Exportar PDF imprime a página: botão e status do Trello não podem sair nele."""
        pg, _ = _abrir(self, Estado())
        pg.emulate_media(media="print")
        self.assertFalse(pg.is_visible("#btn-card-trello"))
        self.assertFalse(pg.is_visible("#btn-atualizar"))
        pg.close()


class TestSaldoNoPainel(unittest.TestCase):
    """O formulário de saldo bancário — lançar, reabrir, corrigir, apagar.

    Existe pela revisão do Arthur (05/10/2026): o painel do hub não tinha teste nenhum do
    formulário, e um saldo digitado errado ficava preso — o aviso de pendente era a única
    porta para o formulário e sumia assim que se salvava."""

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

    def abrir(self, locais=None, planilha=None):
        est = Estado()
        est.painel = _com_saldos(est.painel, planilha=planilha)
        pg, erros = _abrir(self, est, pagina="resumo", locais=locais)
        self.addCleanup(pg.close)
        self.erros = erros
        return pg

    @staticmethod
    def locais(pg):
        return pg.evaluate("JSON.parse(localStorage.getItem('tarituba.saldos.2026') || '{}')")

    @staticmethod
    def botoes(pg):
        return pg.eval_on_selector_all(
            ".btn-saldo", "bs => bs.map(b => b.className.split(' ')[0] + ':' + b.textContent.trim())")

    def preencher(self, pg, corrente, aplicacao, caixa):
        for campo, v in (("corrente", corrente), ("aplicacao", aplicacao), ("caixa", caixa)):
            pg.fill(f"#sld-{campo}", v)

    def test_1_lancar_o_mes_pendente(self):
        pg = self.abrir()
        self.assertEqual(self.botoes(pg), ["btn-acao:Lançar jan"])
        pg.click(".btn-saldo")
        self.assertFalse(pg.is_visible("#sld-limpar"), "mês sem valor no navegador não tem Apagar")
        self.preencher(pg, "1.000,00", "2.000,00", "100,00")
        pg.click("#sld-salvar")
        self.assertEqual(self.locais(pg)["1"], {"corrente": 1000, "aplicacao": 2000, "caixa": 100})
        # sai de pendente e passa a ter a porta de volta
        self.assertEqual(self.botoes(pg), ["btn-ghost:Editar jan"])
        self.assertIn("só neste", pg.text_content(".aviso-saldo.info"))
        self.assertEqual(self.erros, [])

    def test_2_corrigir_um_valor_digitado_errado(self):
        """O caso do Arthur: um zero a mais, salvo, e nenhuma saída pela tela."""
        pg = self.abrir(locais={"1": {"corrente": 10000, "aplicacao": 2000, "caixa": 100}})
        pg.click("text=Editar jan")
        self.assertEqual(pg.input_value("#sld-corrente"), "10.000,00")
        pg.fill("#sld-corrente", "1.000,00")
        pg.click("#sld-salvar")
        self.assertEqual(self.locais(pg)["1"]["corrente"], 1000)
        self.assertEqual(self.erros, [])

    def test_3_apagar_volta_o_mes_para_pendente(self):
        pg = self.abrir(locais={"1": {"corrente": 10000, "aplicacao": 2000, "caixa": 100}})
        pg.click("text=Editar jan")
        pg.click("#sld-limpar")
        self.assertNotIn("1", self.locais(pg))
        self.assertEqual(self.botoes(pg), ["btn-acao:Lançar jan"])
        self.assertEqual(pg.query_selector_all(".aviso-saldo.info"), [])

    def test_4_divergente_apaga_o_do_painel_e_fica_o_da_planilha(self):
        """O aviso diz 'o valor local ficou para trás e pode ser apagado' — e o formulário
        que ele abre não tinha Apagar."""
        pg = self.abrir(locais={"2": {"corrente": 5, "aplicacao": 5, "caixa": 5}})
        self.assertIn("btn-ghost:Ver fev", self.botoes(pg))
        pg.click("text=Ver fev")
        self.assertEqual(pg.input_value("#sld-corrente"), "1.000,00", "campos mostram a planilha")
        dica = pg.text_content(".f-diverge")
        self.assertIn("3.100,00", dica)   # total da planilha
        self.assertIn("15,00", dica)      # total que estava no painel
        pg.click("#sld-limpar")
        self.assertNotIn("2", self.locais(pg))
        self.assertEqual(pg.query_selector_all(".aviso-saldo.alerta"), [])
        self.assertEqual(self.erros, [])

    def test_5_formulario_nao_encosta_no_grafico(self):
        pg = self.abrir()
        pg.click(".btn-saldo")
        fim_form = pg.evaluate("document.getElementById('form-saldo').getBoundingClientRect().bottom")
        topo_seguinte = pg.evaluate(
            "(() => { let n = document.getElementById('slot-form').nextElementSibling;"
            " while (n && !n.offsetHeight) n = n.nextElementSibling;"
            " return n.getBoundingClientRect().top; })()")
        self.assertGreaterEqual(topo_seguinte - fim_form, 16)


def _cadastro():
    """Cadastro sintético coerente com `_payload()`: as mesmas 3 naturezas e grupos."""
    return {"versao": 1, "naturezas": [
        {"ordem": 10, "aba": "receitas", "cod": "13.1.1.01.01", "nome": "RENDIMENTOS",
         "bimer": "000001", "path": ["Receitas", "Receita Financeira"]},
        {"ordem": 20, "aba": "despesas", "cod": "13.2.1.01.01", "nome": "SALARIOS",
         "bimer": "000002", "path": ["Despesas", "Despesas Gerais", "Pessoal"]},
        {"ordem": 30, "aba": "despesas", "cod": "13.2.1.01.02", "nome": "SERVICOS",
         "bimer": "000003", "path": ["Despesas", "Despesas Gerais"]},
    ]}


PENDENTE = {"cod": "13.2.1.01.77", "nome": "NOVA <b>NATUREZA</b>", "bimer": "001999",
            "aba": "despesas", "valor": -40.0}


class TestCadastroNaturezas(unittest.TestCase):
    """O botão "Editar cadastro de naturezas" e a tela que ele abre (16/10/2026)."""

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

    def abrir(self, pendentes=(), cadastro=True):
        est = Estado()
        est.painel["pendentes"] = list(pendentes)
        est.painel["meta"]["estrutura"] = {"origem": "cadastro"}
        est.cadastro = _cadastro() if cadastro else {}
        pg, erros = _abrir(self, est, pagina="resumo")
        self.addCleanup(pg.close)
        self.erros, self.est = erros, est
        return pg

    def entrar(self, pg):
        pg.click("#btn-cadastro")
        pg.wait_for_selector("table.cadastro")

    def nomes(self, pg):
        return pg.eval_on_selector_all("table.cadastro input[data-campo='nome']",
                                       "xs => xs.map(x => x.value)")

    def test_1_botao_abre_o_cadastro_dentro_do_painel(self):
        pg = self.abrir()
        self.assertTrue(pg.is_visible("#btn-cadastro"))
        self.entrar(pg)
        self.assertEqual(self.nomes(pg), ["RENDIMENTOS", "SALARIOS", "SERVICOS"])
        self.assertFalse(pg.is_visible("#nav-slot"), "a navegação do painel some no cadastro")
        self.assertTrue(pg.is_disabled("#ttSalvar"), "nada alterado, nada a gravar")
        self.assertIn("Receitas › Receita Financeira",
                      pg.text_content("table.cadastro tr.grupo"))
        self.assertEqual(self.erros, [])

    def test_2_editar_e_gravar_carimba_so_o_que_mudou(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("table.cadastro tr:has(input[value='SALARIOS']) input[data-campo='nome']",
                "SALARIOS E ORDENADOS")
        self.assertFalse(pg.is_disabled("#ttSalvar"))
        pg.click("#ttSalvar")
        pg.wait_for_timeout(500)
        self.assertEqual(len(self.est.gravacoes), 1)
        nats = {n["cod"]: n for n in self.est.gravacoes[0]["data"]["naturezas"]}
        self.assertEqual(nats["13.2.1.01.01"]["nome"], "SALARIOS E ORDENADOS")
        self.assertIn("atualizado_em", nats["13.2.1.01.01"])
        self.assertNotIn("atualizado_em", nats["13.1.1.01.01"], "carimbo só no que mudou")
        self.assertNotIn("uid", nats["13.2.1.01.01"], "campo da tela não vai para o banco")
        self.assertIn("Cadastro gravado", pg.text_content("#ttStatus"))

    def test_3_problema_bloqueia_a_gravacao(self):
        """Mesma regra do validar() do Python: o Azure recusaria publicar."""
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("table.cadastro tr:has(input[value='SALARIOS']) input[data-campo='bimer']", "12a")
        self.assertTrue(pg.is_visible(".erro-box"))
        self.assertIn("Bimer", pg.text_content(".erro-box"))
        self.assertTrue(pg.is_disabled("#ttSalvar"))
        pg.fill("table.cadastro tr:has(input[value='SALARIOS']) input[data-campo='bimer']", "000003")
        self.assertIn("código do Bimer", pg.text_content(".erro-box"), "repetido com SERVICOS")
        self.assertTrue(pg.is_disabled("#ttSalvar"))

    def test_4_pendente_vira_natureza(self):
        pg = self.abrir(pendentes=[PENDENTE])
        self.entrar(pg)
        self.assertIn("13.2.1.01.77", pg.text_content(".card.destaque"))
        self.assertEqual(pg.query_selector_all(".card.destaque b"), [], "nome da API não vira HTML")
        pg.click("[data-pa='0']")
        self.assertEqual(pg.input_value("#ttFCod"), "13.2.1.01.77", "a API já traz o código")
        self.assertEqual(pg.input_value("#ttFBimer"), "001999")
        self.assertTrue(pg.is_disabled("#ttFAdd"), "falta o grupo")
        pg.select_option("#ttFGrupo", "Despesas › Despesas Gerais › Pessoal")
        pg.fill("#ttFNome", "NOVA NATUREZA")
        pg.click("#ttFAdd")
        self.assertEqual(pg.query_selector_all(".card.destaque"), [], "classificada sai dos pendentes")
        self.assertIn("NOVA NATUREZA", self.nomes(pg))
        pg.click("#ttSalvar")
        pg.wait_for_timeout(500)
        nova = [n for n in self.est.gravacoes[0]["data"]["naturezas"] if n["cod"] == "13.2.1.01.77"][0]
        self.assertEqual((nova["aba"], nova["bimer"], nova["path"]),
                         ("despesas", "001999", ["Despesas", "Despesas Gerais", "Pessoal"]))
        salario = [n for n in self.est.gravacoes[0]["data"]["naturezas"] if n["cod"] == "13.2.1.01.01"][0]
        self.assertGreater(nova["ordem"], salario["ordem"], "entra no fim do grupo")

    def test_5_grupo_novo_tem_de_comecar_pelo_total_da_aba(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.click("#ttAdd")
        pg.fill("#ttFNome", "X")
        pg.fill("#ttFCod", "13.2.1.01.50")
        pg.fill("#ttFBimer", "000050")
        pg.select_option("#ttFGrupo", "__novo__")
        pg.fill("#ttFNovoGrupo", "Outra Raiz > Grupo")
        self.assertIn("total da aba", pg.text_content("[data-erro='grupo']"))
        self.assertTrue(pg.is_disabled("#ttFAdd"))
        pg.fill("#ttFNovoGrupo", "Receitas > Outras Receitas")
        self.assertFalse(pg.is_disabled("#ttFAdd"))
        pg.click("#ttFAdd")
        # grupo novo de Receitas fica junto das receitas, não depois das despesas
        grupos = pg.eval_on_selector_all("table.cadastro tr.grupo td",
                                         "xs => xs.map(x => x.firstChild.textContent.trim())")
        self.assertEqual(grupos, ["Receitas › Receita Financeira", "Receitas › Outras Receitas",
                                  "Despesas › Despesas Gerais › Pessoal", "Despesas › Despesas Gerais"])

    def test_6_conflito_nao_sobrescreve(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("table.cadastro tr:has(input[value='SERVICOS']) input[data-campo='nome']", "SERV")
        self.est.conflito = True
        pg.click("#ttSalvar")
        pg.wait_for_timeout(500)
        self.assertEqual(self.est.gravacoes, [])
        self.assertIn("outra pessoa gravou", pg.text_content("#ttStatus"))

    def test_7_voltar_ao_painel(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("table.cadastro tr:has(input[value='SERVICOS']) input[data-campo='nome']", "SERV")
        pg.once("dialog", lambda d: d.dismiss())
        pg.click("#ttVoltar")
        self.assertTrue(pg.is_visible("table.cadastro"), "cancelou: continua no cadastro")
        pg.once("dialog", lambda d: d.accept())
        pg.click("#ttVoltar")
        pg.wait_for_timeout(300)
        self.assertTrue(pg.is_visible("#b-pag"))
        self.assertTrue(pg.is_visible("#nav-slot"))
        self.assertEqual(self.erros, [])

    def test_8_aviso_de_pendentes_no_painel(self):
        pg = self.abrir(pendentes=[PENDENTE])
        aviso = pg.text_content("#banner-slot")
        self.assertIn("fora do cadastro", aviso)
        self.assertIn("NOVA <b>NATUREZA</b>", aviso, "o nome aparece como texto, não como HTML")
        pg.click("#btn-pend-cadastro")
        pg.wait_for_selector("table.cadastro")
        self.assertTrue(pg.is_visible(".card.destaque"))

    def test_9_cadastro_vazio_abre_e_diz_que_o_painel_veio_da_planilha(self):
        """Antes do seed: a tela abre (vazia, com o aviso), em vez de quebrar."""
        pg = self.abrir(cadastro=False)
        pg.evaluate("TARITUBA_DATA.meta.estrutura = {origem: 'planilha'}")
        self.entrar(pg)
        self.assertIn("ainda veio da planilha", pg.text_content(".banner"))
        self.assertEqual(self.nomes(pg), [])
        self.assertEqual(self.erros, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
