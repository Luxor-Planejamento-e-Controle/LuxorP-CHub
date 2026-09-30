"""Testa o painel de Saldo Bancário com o supabase-js REAL e a rede interceptada.

Por que interceptar HTTP em vez de trocar `window.supabase`: o painel cria o client no
primeiro carregamento e o mantém em cache, então substituir o objeto depois não tem
efeito. Interceptando as requisições, o supabase-js real roda — o que também testa se as
chamadas que escrevemos (storage.download, app_state select/update) produzem as
requisições certas.

Roda sem credencial, sem sessão e sem tocar no Supabase de verdade.

Uso: python assets/saldo_bancario/test_painel.py   (da raiz do repo do hub)
"""

import base64
import json
import urllib.parse
import pathlib
import unittest

AQUI = pathlib.Path(__file__).resolve().parent

FATOS = {
    "meta": {"janela_inicio": "2026-09-09", "janela_fim": "2026-09-16",
             "gerado_em": "11/09/2026 11:47"},
    # `a_pagar_por_conta` e `titulos` saem da MESMA lista no ETL (fatos_logic.gerar_fatos),
    # então aqui também têm de fechar — é isso que permite exigir que o fluxo dia a dia
    # termine no mesmo número da tabela principal.
    "a_pagar_por_conta": {"LUXOR INVESTIMENTOS": 14033.78, "TARITUBA": 149.90},
    "titulos": [
        {"conta": "LUXOR INVESTIMENTOS", "fornecedor": "FORNECEDOR A", "titulo": "1",
         "emissao": "2026-09-01", "vencimento": "2026-09-10", "valor": 14033.78},
        {"conta": "TARITUBA", "fornecedor": "FORNECEDOR B", "titulo": "2",
         "emissao": "2026-09-02", "vencimento": "2026-09-12", "valor": 149.90},
    ],
    # O a receber é publicado INTEIRO pelo ETL, sem regra aplicada — inclusive os títulos
    # da conta que não usa essa fonte. Quem descarta é o painel, contra o cadastro, e é
    # isso que estes dois títulos do BTG estão aqui para provar: se o painel deixasse
    # passar, a conta projetaria R$ 80.000 que a Luxor sabe que não entram.
    "a_receber_por_conta": {"LUXOR INVESTIMENTOS": 7651.44,
                            "LUXOR PARTICIPAÇÃO - BTG": 80000.0},
    "a_receber": [
        {"conta": "LUXOR INVESTIMENTOS", "cliente": "CLIENTE A", "titulo": "R1",
         "emissao": "2026-09-01", "vencimento": "2026-09-11", "valor": 7651.44},
        {"conta": "LUXOR PARTICIPAÇÃO - BTG", "cliente": "CONDÔMINO X", "titulo": "R2",
         "emissao": "2026-08-20", "vencimento": "2026-09-10", "valor": 50000.0},
        {"conta": "LUXOR PARTICIPAÇÃO - BTG", "cliente": "CONDÔMINO Y", "titulo": "R3",
         "emissao": "2026-08-20", "vencimento": "2026-09-15", "valor": 30000.0},
    ],
}

# Espelha a forma real do cadastro, que veio da planilha: cada conta corrente é dona das
# SUAS aplicações, com o nome completo. Dois casos aqui existem de propósito:
#
#   - a conta do BTG tem um FUNDO listado antes do Tesouro Selic. O par de resgate é
#     escolhido pelo nome, não pela ordem — sem isso a sugestão apontaria o fundo errado.
#   - a Tarituba tem uma linha `tipo: "conta"`, que o painel mostra marcada como
#     "conta, não aplicação" e que NÃO pode entrar no Total aplicado.
ESTADO_INICIAL = {
    "contas": [
        {"chave": "LUXOR INVESTIMENTOS", "conta": "Luxor Investimentos - Itau",
         "banco": "ITAU", "colchao": 30000, "ativa": True,
         "investimentos": [{"nome": "Luxor Investimentos - Itau CDB-DI",
                            "tipo": "aplicacao", "banco": "ITAU"}]},
        {"chave": "LUXOR PARTICIPAÇÃO - BTG", "conta": "Luxor Participação - BTG",
         # Espelha o caso real do condomínio: os títulos a receber existem e têm
         # vencimento, mas quase nunca são pagos na data, então a conta trabalha com um
         # valor fixo provisionado no lugar deles.
         "banco": "BTG", "colchao": 0, "ativa": True,
         "a_receber_da_api": False, "a_receber_provisao": 25000,
         "investimentos": [{"nome": "Luxor Participação - BTG Fundo Manga",
                            "tipo": "aplicacao", "banco": "BTG"},
                           {"nome": "Luxor Participação - BTG Tesouro Selic",
                            "tipo": "aplicacao", "banco": "BTG"}]},
        {"chave": "TARITUBA", "conta": "Tarituba - Sicredi",
         "banco": "SICREDI", "colchao": 10000, "ativa": True,
         "investimentos": [{"nome": "Tarituba - Sicredi CDB-DI",
                            "tipo": "aplicacao", "banco": "SICREDI"},
                           {"nome": "Tarituba - Outro Banco",
                            "tipo": "conta", "banco": ""}]},
    ],
    "entradas": {},
}

SALDOS = {
    "LUXOR INVESTIMENTOS": "20.000,00",
    "LUXOR PARTICIPAÇÃO - BTG": "1.204,44",
    "TARITUBA": "50.000,00",
    "Luxor Investimentos - Itau CDB-DI": "856.529,27",
    "Luxor Participação - BTG Fundo Manga": "44.210,05",
    "Luxor Participação - BTG Tesouro Selic": "120.334,87",
    "Tarituba - Sicredi CDB-DI": "48.120,77",
    "Tarituba - Outro Banco": "15.402,66",
}


class TestPainelSaldoBancario(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")

        cls.estado = json.loads(json.dumps(ESTADO_INICIAL))
        # Versão da linha em app_state. O painel lê no boot e devolve no filtro do
        # UPDATE; é assim que ele detecta que alguém gravou no meio do caminho.
        cls.versao = "2026-09-01T00:00:00+00:00"
        cls.gravacoes = []
        cls.erros = []

        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
        cls.pg = cls._b.new_page(viewport={"width": 1400, "height": 900})
        cls.pg.on("pageerror", lambda e: cls.erros.append(str(e)))

        def rota(route, request):
            url, metodo = request.url, request.method
            if "/storage/v1/object/" in url:
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps(FATOS))
            if "/rest/v1/app_state" in url and metodo in ("PATCH", "POST"):
                # Guarda de concorrência: o UPDATE leva `updated_at=eq.<versão lida>`.
                # Com a versão vencida nenhuma linha casa e o PostgREST devolve lista
                # vazia — é esse vazio, e não um erro, que o painel traduz em "recarregue".
                pedida = None
                if "updated_at=eq." in url:
                    pedida = urllib.parse.unquote(
                        url.split("updated_at=eq.")[1].split("&")[0])
                if pedida is not None and pedida != cls.versao:
                    return route.fulfill(status=200, content_type="application/json",
                                         body="[]")
                corpo = json.loads(request.post_data)
                cls.gravacoes.append(corpo)
                cls.estado = corpo["data"]
                cls.versao = corpo.get("updated_at") or cls.versao
                return route.fulfill(
                    status=200, content_type="application/json",
                    body=json.dumps([{"id": "saldo_bancario", "updated_at": cls.versao}]))
            if "/rest/v1/app_state" in url:
                # maybeSingle() pede objeto único (Accept: application/vnd.pgrst.object+json)
                return route.fulfill(status=200,
                                     content_type="application/vnd.pgrst.object+json",
                                     body=json.dumps({"data": cls.estado,
                                                      "updated_at": cls.versao}))
            return route.continue_()

        cls.pg.route("**/*.supabase.co/**", rota)
        cls.pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
        cls.pg.goto((AQUI / "index.html").as_uri())
        cls.pg.wait_for_timeout(1300)

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    # ---------------- formulário ----------------

    def test_1_abre_no_formulario(self):
        """Com saldo faltando, a tela pede o input — não mostra projeção com conta
        zerada, que pareceria completa e diria que sobra dinheiro onde ninguém informou."""
        self.assertIn("Informe os saldos", self.pg.inner_text("body"))
        self.assertEqual(self.pg.locator("input.sbf[data-campo=saldo]").count(), 8,
                         "3 contas correntes + 5 investimentos")
        self.assertEqual(self.pg.locator("#sbfVoltar").count(), 0,
                         "na primeira vez não há projeção para onde voltar")

    def test_1b_formulario_repete_a_hierarquia_do_painel(self):
        """O formulário é a mesma tela do painel, não uma tela de configuração à parte:
        mesma tabela, mesmas linhas, aplicações aninhadas sob a conta delas."""
        pg = self.pg
        self.assertEqual(pg.locator("tr.conta-cc").count(), 3)
        self.assertEqual(pg.locator("tr.inv").count(), 5)
        self.assertEqual(pg.locator("tr.falta-saldo").count(), 3,
                         "as três contas ainda sem saldo vêm marcadas")
        self.assertIn("conta, não aplicação", pg.inner_text("body"))

    def test_1c_mascara_de_real(self):
        """Os dígitos entram pela direita, como em caixa de banco. Quem digita saldo o dia
        inteiro conta com isso, e é o que evita "20000" virar vinte mil e um centavo."""
        pg = self.pg
        sel = 'input.sbf[data-campo=saldo][data-chave="TARITUBA"]'
        for teclas, esperado in [("1", "R$ 0,01"), ("12", "R$ 0,12"),
                                 ("1234", "R$ 12,34"), ("123456", "R$ 1.234,56"),
                                 ("85652927", "R$ 856.529,27")]:
            pg.fill(sel, "")
            pg.type(sel, teclas, delay=5)
            self.assertEqual(pg.input_value(sel), esperado, f"digitando {teclas}")

        # Backspace apaga um DÍGITO, não um separador: o valor reformata sozinho.
        pg.press(sel, "Backspace")
        self.assertEqual(pg.input_value(sel), "R$ 85.652,92")

        # o valor lido é sempre dígitos/100, e o campo marcado como preenchido
        self.assertAlmostEqual(
            pg.evaluate("() => SB_FORM.numero(document.querySelector("
                        "'input.sbf[data-chave=\\\"TARITUBA\\\"]').value)"),
            85652.92, places=2)
        self.assertTrue(pg.locator(sel).evaluate("el => el.classList.contains('ok')"))

        pg.fill(sel, "")   # devolve o campo vazio para os testes seguintes

    def test_1d_a_entrada_nao_se_digita_mais_aqui(self):
        """A entrada prevista saiu do formulário e virou provisão (Leonardo, 29/09/2026).

        O campo era um valor por conta e SEM data, e o fluxo dia a dia tinha de chutar
        onde encaixá-lo. Enquanto ele existiu nesta tela, quem digitasse ali estaria
        alimentando um número que o painel já não lê — o pior estado possível, porque a
        tela aceita, grava e nada acontece."""
        pg = self.pg
        self.assertEqual(pg.locator('input.sbf[data-campo=a_receber]').count(), 0,
                         "nenhum campo de entrada no formulário de saldos")

    def test_1e_a_entrada_aparece_de_leitura_com_a_origem(self):
        """Quem informa o saldo precisa ver o que já está previsto entrar — e de onde
        veio, senão o jeito de corrigir um número errado fica invisível: título se corrige
        no Bimer, provisão no editor, entrada fixa no cadastro."""
        pg = self.pg
        linha = pg.locator('tr.conta-cc', has_text="Luxor Participação")
        self.assertIn("R$ 25.000,00", linha.inner_text(),
                      "a provisão do cadastro aparece na conta que a tem")
        self.assertIn("provisão", linha.inner_text().lower())

        outra = pg.locator('tr.conta-cc', has_text="Luxor Investimentos")
        self.assertIn("R$ 7.651,44", outra.inner_text(),
                      "e o título da API aparece na conta que usa a API")

    def test_1f_o_a_receber_do_bimer_e_descartado_por_cadastro(self):
        """O ETL publica os títulos a receber inteiros; é o painel que descarta os da
        conta com `a_receber_da_api: false`.

        Sem o descarte, esta conta somaria os R$ 80.000 dos títulos AOS R$ 25.000 da
        provisão: a projeção contaria R$ 105.000 onde a Luxor espera R$ 25.000."""
        por = {c["chave"]: c for c in
               self.pg.evaluate("() => window.SB_PAINEL.estado().contas")}
        btg = por["LUXOR PARTICIPAÇÃO - BTG"]
        self.assertEqual(btg["aReceberApi"], 0, "os títulos do Bimer não entram nesta conta")
        self.assertEqual(btg["aReceberProvisao"], 25000)
        self.assertEqual(btg["aReceber"], 25000)

        inv = por["LUXOR INVESTIMENTOS"]
        self.assertAlmostEqual(inv["aReceberApi"], 7651.44, places=2,
                               msg="a conta que usa a API continua somando o título")
        self.assertEqual(inv["aReceberProvisao"], 0)

    def test_1g_a_provisao_automatica_cai_na_quarta_que_abre(self):
        """Decisão do Leonardo (29/09/2026): a quarta de ABERTURA, não as duas da janela.

        A data importa porque o fluxo dia a dia é o que mostra se a conta fura no meio da
        semana. Jogar a entrada no fim da janela esconderia exatamente esse furo."""
        est = self.pg.evaluate("() => window.SB_PAINEL.estado()")
        auto = [e for e in est["entradasProvisionadas"] if e.get("automatica")]
        self.assertEqual(len(auto), 1, "uma conta com entrada fixa no cadastro")
        self.assertEqual(auto[0]["vencimento"], est["janela"][0],
                         "cai na quarta que abre a janela")
        self.assertEqual(auto[0]["valor"], 25000)

    def test_2_fatos_vieram_do_bucket(self):
        est = self.pg.evaluate("() => window.SB_PAINEL.estado()")
        self.assertEqual(est["janela"], ["2026-09-09", "2026-09-16"])
        por_chave = {c["chave"]: c for c in est["contas"]}
        self.assertAlmostEqual(por_chave["LUXOR INVESTIMENTOS"]["aPagar"], 14033.78, places=2)

    # ---------------- gravação e projeção ----------------

    def test_3_grava_e_mostra_a_projecao(self):
        pg = self.pg
        for chave, valor in SALDOS.items():
            pg.fill(f'input.sbf[data-campo=saldo][data-chave="{chave}"]', valor)
        pg.click("#sbfSalvar")
        pg.wait_for_timeout(1300)

        self.assertTrue(self.gravacoes, "nada foi gravado em app_state")
        doc = self.gravacoes[-1]["data"]
        # A chave é a QUARTA da semana CORRENTE, que muda conforme o dia em que o teste
        # roda. Fixar a data aqui fazia o teste quebrar sozinho na quarta seguinte.
        semana = self.pg.evaluate("() => window.SB_PAINEL.estado().semana")
        self.assertEqual(list(doc["entradas"].keys()), [semana],
                         "entrada guardada pela quarta da semana")
        self.assertEqual(len(doc["contas"]), 3,
                         "o cadastro das contas não pode ser perdido ao gravar o formulário")
        self.assertEqual(len(doc["contas"][1]["investimentos"]), 2,
                         "as aplicações da conta também não podem sumir na gravação")
        self.assertEqual(doc["entradas"][semana][0]["por"],
                         "fulano@luxor.com.br", "registra quem digitou")
        self.assertIn("SALDO RESTANTE", self.pg.inner_text("body").upper())

    def test_3c_semana_vem_da_janela_publicada(self):
        """O ETL roda na TERÇA e publica a janela que começa na quarta. Se a semana
        viesse do relógio de quem abre, na terça a pessoa veria a projeção de uma semana
        e digitaria os saldos na anterior — e eles sumiriam na quarta, sem erro nenhum."""
        semana = self.pg.evaluate("() => window.SB_PAINEL.estado().semana")
        self.assertEqual(semana, FATOS["meta"]["janela_inicio"],
                         "a semana é a da janela publicada, não a do navegador")
        doc = self.gravacoes[-1]["data"]
        self.assertEqual(list(doc["entradas"].keys()), [semana],
                         "e é nela que os saldos são gravados")

    def test_4_numeros_da_projecao(self):
        por = {c["chave"]: c for c in
               self.pg.evaluate("() => window.SB_PAINEL.estado().contas")}

        # 20.000 − 14.033,78 + 7.651,44 (título a receber da API) = 13.617,66 ;
        # colchão 30.000 → resgatar 20k (degrau de 5k, arredondando para cima)
        li = por["LUXOR INVESTIMENTOS"]
        self.assertAlmostEqual(li["restante"], 13617.66, places=2)
        self.assertEqual(li["acao"], "resgate")
        self.assertEqual(li["valor"], 20000)
        self.assertEqual(li["par_nome"], "Luxor Investimentos - Itau CDB-DI")
        self.assertEqual(li["par_saldo"], 856529.27)

        # 50.000 − 149,90 = 49.850,10 ; colchão 10.000 → aplicar 35k
        # (a entrada de 5.000 que este teste somava era digitada no formulário; esse
        #  campo saiu, e o que a Tarituba tem a receber agora é o que vier da API)
        t = por["TARITUBA"]
        self.assertAlmostEqual(t["restante"], 49850.10, places=2)
        self.assertEqual(t["acao"], "Aplicar")
        self.assertEqual(t["valor"], 35000)

        # colchão 0 com sobra: conta em descontinuação não recebe aplicação.
        # Os R$ 25.000 aqui são a provisão do cadastro — os R$ 80.000 de título a
        # receber do Bimer foram descartados por `a_receber_da_api: false`.
        btg = por["LUXOR PARTICIPAÇÃO - BTG"]
        self.assertAlmostEqual(btg["restante"], 26204.44, places=2)
        self.assertIsNone(btg["acao"])
        self.assertTrue(btg["descontinuada"])

    def test_4b_par_do_btg_e_o_tesouro_nao_o_fundo(self):
        """O Fundo Manga está listado ANTES do Tesouro Selic. Pegar o primeiro da lista
        mandaria o gestor resgatar do fundo errado — a escolha é pelo nome."""
        por = {c["chave"]: c for c in
               self.pg.evaluate("() => window.SB_PAINEL.estado().contas")}
        self.assertEqual(por["LUXOR PARTICIPAÇÃO - BTG"]["par_nome"],
                         "Luxor Participação - BTG Tesouro Selic")

    def test_5_total_aplicado_ignora_o_que_nao_e_aplicacao(self):
        """Soma só as linhas `tipo: aplicacao`. A "Tarituba - Outro Banco" é conta
        corrente pendurada ali e entraria como dinheiro aplicado que não existe."""
        celula = self.pg.locator("tr.aplicado td.num").first.inner_text()
        # 856.529,27 + 44.210,05 + 120.334,87 + 48.120,77  (sem os 15.402,66 da conta)
        self.assertEqual(celula.replace("\xa0", " "), "R$ 1.069.194,96")

    def test_6_origem_e_datas_reais(self):
        """O painel nasceu lendo planilha; no hub a origem é o arquivo do bucket. Nenhum
        campo de data pode vazar 'undefined' para a tela."""
        txt = self.pg.inner_text("body")
        self.assertIn("saldo_bancario.json", txt)
        self.assertIn("11/09/2026 às 11:47", txt)
        self.assertNotIn("undefined", txt)
        self.assertNotIn("servidor.py", txt, "aviso da versão local não vale no hub")

    def test_7_corrigir_saldos_e_voltar(self):
        pg = self.pg
        pg.click("#btEditarSaldos")
        pg.wait_for_timeout(500)
        self.assertEqual(pg.input_value(
            'input.sbf[data-campo=saldo][data-chave="LUXOR INVESTIMENTOS"]'), "R$ 20.000,00",
            "o campo volta mascarado, igual ao que a pessoa vê digitando")
        self.assertEqual(pg.locator("tr.falta-saldo").count(), 0,
                         "com tudo informado, nenhuma conta fica marcada")
        self.assertEqual(pg.locator("#sbfVoltar").count(), 1,
                         "com projeção já calculada, dá para desistir da correção")

        antes = len(self.gravacoes)
        pg.click("#sbfVoltar")
        pg.wait_for_timeout(500)
        self.assertIn("Sugestões de Movimentação", pg.inner_text("body"))
        self.assertEqual(len(self.gravacoes), antes, "Voltar não pode gravar nada")

    def test_7b_corrigir_saldo_nao_apaga_a_entrada_prevista(self):
        """Gravar o formulário de saldos não pode levar as provisões junto.

        Este é o mesmo defeito que já foi corrigido uma vez (PR #12): `salvar` substituía
        a lista inteira da semana, e o formulário a chamava sem argumento nenhum. Antes
        ele apagava as saídas provisionadas; agora as ENTRADAS moram no mesmo lugar, então
        corrigir um saldo apagaria também o dinheiro que a semana espera receber."""
        pg = self.pg
        antes = {c["chave"]: c["aReceber"] for c in
                 pg.evaluate("() => window.SB_PAINEL.estado().contas")}
        self.assertEqual(antes["LUXOR PARTICIPAÇÃO - BTG"], 25000, "pré-condição")

        pg.click("#btEditarSaldos")
        pg.wait_for_timeout(500)
        pg.fill('input.sbf[data-campo=saldo][data-chave="TARITUBA"]', "51.000,00")
        pg.click("#sbfSalvar")
        pg.wait_for_timeout(1100)

        depois = {c["chave"]: c["aReceber"] for c in
                  pg.evaluate("() => window.SB_PAINEL.estado().contas")}
        self.assertEqual(depois, antes,
                         "as entradas previstas continuam as mesmas depois de salvar saldos")

    # ---------------- abas de detalhamento ----------------
    #
    # Estas abas quase foram para produção quebradas: o ETL publica `conta` e o painel
    # filtra por `chave`, então o cabeçalho contava "2 títulos" e a tabela dizia
    # "Nenhum", sem um único erro de console. Nenhum teste as abria.

    def test_8_aba_titulos_lista_o_que_veio_do_etl(self):
        pg = self.pg
        pg.click("text=Títulos a pagar e receber")
        pg.wait_for_timeout(600)
        txt = pg.inner_text("body")
        self.assertIn("FORNECEDOR A", txt, "título do ETL não apareceu na aba")
        self.assertNotIn("Nenhum título nesta janela", txt)
        self.assertIn("LUXOR INVESTIMENTOS", txt)

    def test_8b_fluxo_fecha_com_o_saldo_restante(self):
        """Invariante que o próprio painel declara: o último dia do fluxo tem de bater
        com o "saldo restante" da tabela principal — as duas vêm de saldo, a pagar e a
        receber. Divergência ali é erro de sinal, não arredondamento."""
        pg = self.pg
        pg.click("text=Fluxo de caixa")
        pg.wait_for_timeout(600)

        ultimo = pg.evaluate("""() => {
            const out = {};
            document.querySelectorAll('table tbody tr').forEach(tr => {
                const nome = tr.querySelector('.forn');
                const dias = tr.querySelectorAll('td.dia');
                if(nome && dias.length) out[nome.textContent.trim()] =
                    dias[dias.length-1].getAttribute('title');
            });
            return out;
        }""")
        est = {c["chave"]: c for c in
               pg.evaluate("() => window.SB_PAINEL.estado().contas")}

        def num(titulo):  # "... em 16/09/2026: R$ 5.966,22" -> 5966.22
            v = titulo.split(":")[-1].split("(")[0]
            v = v.replace("\xa0", " ").replace("R$", "").replace("−", "-").strip()
            return float(v.replace(".", "").replace(",", "."))

        self.assertTrue(ultimo, "o fluxo não renderizou nenhuma linha")
        for nome, titulo in ultimo.items():
            with self.subTest(conta=nome):
                chave = next(k for k, c in est.items() if c["conta"] == nome)
                self.assertAlmostEqual(
                    num(titulo), est[chave]["restante"], places=2,
                    msg=f"{nome}: fluxo fecha em {num(titulo)}, "
                        f"tabela diz {est[chave]['restante']}")

    # ---------------- provisões (saídas fora do Bimer) ----------------
    #
    # Na planilha eram linhas da Base CAP com título vazio: pagamento que ainda não foi
    # lançado no Bimer. Sem elas a projeção fica otimista pelo valor da provisão — foi
    # assim que os R$ 6.330 da Tarituba sumiram na primeira versão deste painel.

    def test_8c_adicionar_provisao_muda_o_restante(self):
        pg = self.pg
        # o seletor de detalhamento é TOGGLE: clicar numa aba aberta fecha. Garante aberta.
        if not pg.locator("#tbody").count():
            pg.click("text=Títulos a pagar e receber")
            pg.wait_for_timeout(500)

        antes = {c["chave"]: c["restante"] for c in
                 pg.evaluate("() => window.SB_PAINEL.estado().contas")}

        pg.click("#btEditar")
        pg.wait_for_timeout(500)
        # Agora os títulos do Bimer ENTRAM na edição — eles viram ajustes presos à `ref`,
        # que sobrevivem à republicação do ETL. O que não pode acontecer é provisão nascer
        # sozinha: tudo que está aqui neste momento veio do Bimer.
        uids = pg.eval_on_selector_all('#tbody tr[data-uid]', "ts => ts.map(t => t.dataset.uid)")
        self.assertEqual(len(uids), len(FATOS["titulos"]),
                         "os títulos do Bimer entram; provisão nenhuma ainda")
        self.assertTrue(all(u.startswith("saida:t") for u in uids), uids)

        pg.click("#btAddSaida")
        pg.wait_for_timeout(400)
        linha = "#tbody tr:last-child"
        # O editor escuta 'change', não 'input' — de propósito: re-renderizar a cada
        # tecla tiraria o foco do campo. `fill` sozinho não borra, então o Tab aqui é o
        # que uma pessoa faz naturalmente ao passar para o próximo campo.
        def preencher(seletor, valor):
            pg.fill(f'{linha} {seletor}', valor)
            pg.press(f'{linha} {seletor}', "Tab")
            pg.wait_for_timeout(150)

        pg.select_option(f'{linha} select[data-c="chave"]', "TARITUBA")
        pg.wait_for_timeout(150)
        preencher('input[data-c="pessoa"]', "PAGAMENTO NÃO LANÇADO")
        preencher('input[data-c="valor"]', "6330")
        preencher('input[data-c="vencimento"]', "2026-09-12")

        pg.once("dialog", lambda d: d.accept())
        pg.click("#btAplicar")
        pg.wait_for_timeout(1500)

        depois = {c["chave"]: c["restante"] for c in
                  pg.evaluate("() => window.SB_PAINEL.estado().contas")}
        self.assertAlmostEqual(depois["TARITUBA"], antes["TARITUBA"] - 6330, places=2,
                               msg="a provisão tem de sair do restante")
        self.assertAlmostEqual(depois["LUXOR INVESTIMENTOS"], antes["LUXOR INVESTIMENTOS"],
                               places=2, msg="e não pode tocar nas outras contas")

        doc = self.gravacoes[-1]["data"]
        semana = pg.evaluate("() => window.SB_PAINEL.estado().semana")
        self.assertEqual(len(doc["provisoes"][semana]), 1)
        self.assertEqual(doc["provisoes"][semana][0]["valor"], 6330,
                         "guardado positivo: o sinal é da coluna, não do que se digita")
        self.assertIn(semana, doc["entradas"],
                      "gravar provisão não pode apagar os saldos digitados")

    def test_8d_provisao_aparece_na_aba_e_no_fluxo(self):
        pg = self.pg
        if not pg.locator("#tbody").count():
            pg.click("text=Títulos a pagar e receber")
            pg.wait_for_timeout(500)
        self.assertIn("PAGAMENTO NÃO LANÇADO", pg.inner_text("body"))

        # o fluxo tem de continuar fechando com o restante, agora com a provisão dentro
        pg.click("text=Fluxo de caixa")
        pg.wait_for_timeout(500)
        ultimo = pg.evaluate("""() => {
            const out = {};
            document.querySelectorAll('table tbody tr').forEach(tr => {
                const nome = tr.querySelector('.forn');
                const dias = tr.querySelectorAll('td.dia');
                if(nome && dias.length) out[nome.textContent.trim()] =
                    dias[dias.length-1].getAttribute('title');
            });
            return out;
        }""")
        est = {c["chave"]: c for c in
               pg.evaluate("() => window.SB_PAINEL.estado().contas")}

        def num(t):
            v = t.split(":")[-1].split("(")[0]
            v = v.replace(" ", " ").replace("R$", "").replace("−", "-").strip()
            return float(v.replace(".", "").replace(",", "."))

        for nome, titulo in ultimo.items():
            with self.subTest(conta=nome):
                chave = next(k for k, c in est.items() if c["conta"] == nome)
                self.assertAlmostEqual(num(titulo), est[chave]["restante"], places=2)

    # Estes dois dependem da provisão que o 8c cria, e o unittest roda em ordem
    # ALFABÉTICA do nome do método. Nasceram como "8c2"/"8c3" e rodavam ANTES do
    # "8c_adicionar…", porque '2' vem antes de '_' na tabela ASCII — o teste falhava
    # apontando a mudança, não o próprio nome.
    def test_8e_entrada_provisionada_entra_no_restante(self):
        """As entradas manuais viraram provisão (Leonardo, 29/09/2026), então o editor
        grava os dois sinais na MESMA lista. O campo que separa um do outro é `tipo`, e
        ele é o que não perdoa esquecimento: sem ele a entrada é lida como saída e o erro
        é do dobro do valor, para o lado errado."""
        pg = self.pg
        if not pg.locator("#tbody").count():
            pg.click("text=Títulos a pagar e receber")
            pg.wait_for_timeout(500)

        antes = {c["chave"]: c for c in
                 pg.evaluate("() => window.SB_PAINEL.estado().contas")}

        pg.click("#btEditar")
        pg.wait_for_timeout(500)
        pg.click("#btAddEntrada")
        pg.wait_for_timeout(400)
        linha = "#tbody tr:last-child"

        def preencher(seletor, valor):
            pg.fill(f'{linha} {seletor}', valor)
            pg.press(f'{linha} {seletor}', "Tab")
            pg.wait_for_timeout(150)

        self.assertEqual(pg.input_value(f'{linha} select[data-c="tipo"]'), "entrada",
                         "o botão nasce com o tipo certo")
        pg.select_option(f'{linha} select[data-c="chave"]', "LUXOR INVESTIMENTOS")
        pg.wait_for_timeout(150)
        preencher('input[data-c="pessoa"]', "ALUGUEL COMBINADO")
        preencher('input[data-c="valor"]', "4200")
        preencher('input[data-c="vencimento"]', "2026-09-11")

        pg.once("dialog", lambda d: d.accept())
        pg.click("#btAplicar")
        pg.wait_for_timeout(1500)

        depois = {c["chave"]: c for c in
                  pg.evaluate("() => window.SB_PAINEL.estado().contas")}
        alvo = "LUXOR INVESTIMENTOS"
        self.assertAlmostEqual(depois[alvo]["aReceber"], antes[alvo]["aReceber"] + 4200,
                               places=2, msg="a entrada soma no a receber da conta")
        self.assertAlmostEqual(depois[alvo]["restante"], antes[alvo]["restante"] + 4200,
                               places=2, msg="e ENTRA no restante, não sai")
        self.assertAlmostEqual(depois[alvo]["aPagar"], antes[alvo]["aPagar"], places=2,
                               msg="entrada não pode virar saída")

        semana = pg.evaluate("() => window.SB_PAINEL.estado().semana")
        provs = self.gravacoes[-1]["data"]["provisoes"][semana]
        por_desc = {p["descricao"]: p for p in provs}
        self.assertEqual(por_desc["ALUGUEL COMBINADO"]["tipo"], "entrada")
        self.assertEqual(por_desc["ALUGUEL COMBINADO"]["valor"], 4200,
                         "guardado positivo: o sinal é do tipo, não do que se digita")
        self.assertEqual(por_desc["PAGAMENTO NÃO LANÇADO"]["tipo"], "saida",
                         "gravar a entrada não pode reetiquetar a saída que já estava lá")

    def test_8f_a_entrada_volta_como_entrada_ao_reabrir(self):
        """A segunda vez é onde este tipo de mudança quebra: grava certo, relê errado.

        Se o editor não reconstruísse o tipo ao reabrir, a entrada voltaria como saída e
        bastaria gravar de novo — sem tocar nela — para o valor trocar de sinal."""
        pg = self.pg
        if not pg.locator("#tbody").count():
            pg.click("text=Títulos a pagar e receber")
            pg.wait_for_timeout(500)
        pg.click("#btEditar")
        pg.wait_for_timeout(600)

        tipos = pg.evaluate("""() => {
            const out = {};
            document.querySelectorAll('#tbody tr[data-uid]').forEach(tr => {
                const p = tr.querySelector('input[data-c="pessoa"]');
                const t = tr.querySelector('select[data-c="tipo"]');
                if(p && t) out[p.value] = t.value;
            });
            return out;
        }""")
        self.assertEqual(tipos.get("ALUGUEL COMBINADO"), "entrada")
        self.assertEqual(tipos.get("PAGAMENTO NÃO LANÇADO"), "saida")

        # a automática do cadastro NÃO entra no editor: ela nasce a cada carregamento e
        # não é gravada, então gravá-la aqui a duplicaria na abertura seguinte
        self.assertNotIn("Entrada prevista (cadastro)", list(tipos.keys()))

        pg.click("#btCancelar")
        pg.wait_for_timeout(500)

    def test_a_conflito_nao_sobrescreve_gravacao_alheia(self):
        """Duas telas abertas: a que gravar depois não pode apagar o que a outra gravou.

        `app_state` guarda o documento INTEIRO, então gravar aqui é read-modify-write. Sem
        a guarda de versão, a segunda tela sobe a leitura que fez no boot e o trabalho da
        primeira some sem erro nenhum.

        Roda por último de propósito (o `_a_` ordena depois de `_9_`): deixa o formulário
        num estado de erro, e os testes desta classe dividem a mesma página."""
        pg = self.pg
        pg.click("#btEditarSaldos")
        pg.wait_for_timeout(500)
        pg.fill('input.sbf[data-campo=saldo][data-chave="TARITUBA"]', "1.234,00")

        # outra pessoa gravou entre o carregamento desta tela e o clique em Salvar
        type(self).versao = "2099-01-01T00:00:00+00:00"

        antes = len(self.gravacoes)
        pg.click("#sbfSalvar")
        pg.wait_for_timeout(900)

        self.assertEqual(len(self.gravacoes), antes,
                         "com a versão vencida, nada pode ser escrito")
        self.assertIn("recarregue o painel", pg.inner_text("#sbfStatus").lower())
        self.assertIn("1.234", pg.input_value(
            'input.sbf[data-campo=saldo][data-chave="TARITUBA"]'),
            "o que a pessoa digitou continua na tela")

    def test_9_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")


class TestSemFatosPublicados(unittest.TestCase):
    """A semana em que o ETL ainda não publicou — que é a primeira semana de todas.

    Classe à parte porque o cenário é o bucket VAZIO, e a classe de cima divide uma
    página só, com o arquivo sempre presente.

    Regressão de um erro visto em produção: a pessoa digitou os saldos, a gravação
    funcionou, e a tela disse "não foi possível salvar: Cannot read properties of null
    (reading '0')". Sem fatos não há janela, `D.janela` era null, e o painel montado logo
    após a gravação estourava ao formatar a data — dentro do mesmo try do salvar, que
    então culpou a gravação. Quem lê essa mensagem digita tudo de novo à toa.
    """

    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")

        cls.estado = json.loads(json.dumps(ESTADO_INICIAL))
        cls.versao = "2026-09-01T00:00:00+00:00"
        cls.gravacoes = []
        cls.erros = []

        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
        cls.pg = cls._b.new_page(viewport={"width": 1400, "height": 900})
        cls.pg.on("pageerror", lambda e: cls.erros.append(str(e)))

        def rota(route, request):
            url, metodo = request.url, request.method
            if "/storage/v1/object/" in url:
                # o que o Storage responde quando o arquivo não existe
                return route.fulfill(
                    status=400, content_type="application/json",
                    body=json.dumps({"statusCode": "404", "error": "not_found",
                                     "message": "Object not found"}))
            if "/rest/v1/app_state" in url and metodo in ("PATCH", "POST"):
                corpo = json.loads(request.post_data)
                cls.gravacoes.append(corpo)
                cls.estado = corpo["data"]
                cls.versao = corpo.get("updated_at") or cls.versao
                return route.fulfill(
                    status=200, content_type="application/json",
                    body=json.dumps([{"id": "saldo_bancario", "updated_at": cls.versao}]))
            if "/rest/v1/app_state" in url:
                return route.fulfill(status=200,
                                     content_type="application/vnd.pgrst.object+json",
                                     body=json.dumps({"data": cls.estado,
                                                      "updated_at": cls.versao}))
            return route.continue_()

        cls.pg.route("**/*.supabase.co/**", rota)
        cls.pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
        cls.pg.goto((AQUI / "index.html").as_uri())
        cls.pg.wait_for_timeout(1300)

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def test_1_avisa_que_as_saidas_nao_foram_publicadas(self):
        """Sem esse aviso a tela é indistinguível da semana normal: o formulário é o
        mesmo, e o que muda — saída zero em toda conta — só apareceria depois, como uma
        projeção folgada que ninguém tem por que desconfiar."""
        texto = self.pg.inner_text("body")
        self.assertIn("ainda não foram publicadas", texto)
        self.assertIn("otimista", texto)

    def test_2_grava_e_continua_no_formulario(self):
        pg = self.pg
        for chave, valor in SALDOS.items():
            pg.fill(f'input.sbf[data-campo=saldo][data-chave="{chave}"]', valor)
        pg.click("#sbfSalvar")
        pg.wait_for_timeout(900)

        self.assertEqual(len(self.gravacoes), 1, "a gravação tem de acontecer")
        status = pg.inner_text("#sbfStatus")
        self.assertNotIn("não foi possível salvar", status,
                         f"a gravação funcionou; a mensagem não pode culpá-la: {status!r}")
        self.assertNotIn("não recarregou", status, f"render quebrou: {status!r}")

    def test_3_nao_monta_painel_sem_janela(self):
        """Com os saldos todos informados e nenhum fato, a projeção fecharia as contas
        contra saída nenhuma — completa na aparência e otimista pela semana inteira. A
        tela fica no formulário até o ETL publicar."""
        pg = self.pg
        self.assertFalse(pg.evaluate("SB_PAINEL.estado().completo"))
        self.assertFalse(pg.evaluate("SB_PAINEL.estado().temFatos"))
        self.assertEqual(pg.locator("#sbfSalvar").count(), 1,
                         "continua no formulário, não no painel")

    def test_4_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")


class TestAjustesEmTitulosDoBimer(unittest.TestCase):
    """Editar um título que veio da API — valor, vencimento, conta, ou tirar da projeção.

    O que se guarda NÃO é o título editado: é um ajuste preso a uma `ref`, reaplicado
    sobre o título que o ETL republica. Sem isso a edição se perderia na quarta seguinte,
    e o jeito de descobrir seria o número voltar sozinho.

    Os títulos aqui reproduzem o que os dados reais têm de pior para identificar uma
    linha: dois dividindo o número (parcelas de luz) e dois iguais em tudo menos o valor.
    É onde uma chave fraca aplicaria o ajuste na linha errada — e a conta bateria mesmo
    assim no total, escondendo o erro.
    """

    FATOS = {
        "meta": {"janela_inicio": "2026-09-23", "janela_fim": "2026-09-30",
                 "gerado_em": "22/09/2026 08:00"},
        "a_pagar_por_conta": {"LUXOR INVESTIMENTOS": 3000.0, "TARITUBA": 1500.0},
        "titulos": [
            {"conta": "LUXOR INVESTIMENTOS", "fornecedor": "ALUGUEL", "titulo": "A1",
             "emissao": "2026-09-01", "vencimento": "2026-09-24", "valor": 1000.0},
            # mesmo número, vencimentos diferentes — parcelas, como a conta de luz real
            {"conta": "LUXOR INVESTIMENTOS", "fornecedor": "LUZ", "titulo": "LIGHT2026",
             "emissao": "2026-09-08", "vencimento": "2026-09-25", "valor": 800.0},
            {"conta": "LUXOR INVESTIMENTOS", "fornecedor": "LUZ", "titulo": "LIGHT2026",
             "emissao": "2026-09-08", "vencimento": "2026-09-28", "valor": 1200.0},
            {"conta": "TARITUBA", "fornecedor": "RACAO", "titulo": "R7",
             "emissao": "2026-09-02", "vencimento": "2026-09-26", "valor": 1500.0},
        ],
    }
    ESTADO = {
        "contas": [
            {"chave": "LUXOR INVESTIMENTOS", "conta": "Luxor Investimentos - Itau",
             "banco": "ITAU", "colchao": 1000, "ativa": True, "investimentos": []},
            {"chave": "TARITUBA", "conta": "Tarituba - Sicredi",
             "banco": "SICREDI", "colchao": 1000, "ativa": True, "investimentos": []},
        ],
        "entradas": {"2026-09-23": [
            {"chave": "LUXOR INVESTIMENTOS", "saldo": 50000.0, "a_receber": 0,
             "por": "fulano@luxor.com.br", "em": "2026-09-23T10:00:00Z"},
            {"chave": "TARITUBA", "saldo": 30000.0, "a_receber": 0,
             "por": "fulano@luxor.com.br", "em": "2026-09-23T10:00:00Z"}]},
    }

    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def abrir(self, estado=None, fatos=None):
        """Página nova, estado próprio. Cada teste mexe no documento gravado, então
        dividir a página entre eles faria um teste herdar o ajuste do outro."""
        self.estado = estado if estado is not None else json.loads(json.dumps(self.ESTADO))
        self.fatos = fatos or self.FATOS
        erros = []
        pg = self._b.new_page(viewport={"width": 1400, "height": 950})
        pg.on("pageerror", lambda e: erros.append(str(e)))
        self.erros = erros

        def rota(route, request):
            u = request.url
            if "/storage/v1/object/" in u:
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps(self.fatos))
            if "/rest/v1/app_state" in u and request.method in ("PATCH", "POST"):
                self.estado = json.loads(request.post_data)["data"]
                return route.fulfill(status=200, content_type="application/json",
                                     body='[{"id":"saldo_bancario","updated_at":"z"}]')
            if "/rest/v1/app_state" in u:
                return route.fulfill(
                    status=200, content_type="application/vnd.pgrst.object+json",
                    body=json.dumps({"data": self.estado, "updated_at": "z"}))
            return route.continue_()

        pg.route("**/*.supabase.co/**", rota)
        pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
        pg.goto((AQUI / "index.html").as_uri())
        pg.wait_for_timeout(1400)
        self.pg = pg
        return pg

    def tearDown(self):
        if getattr(self, "pg", None):
            self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")
            self.pg.close()

    # ------------------------------------------------------------------ helpers

    def editar(self):
        self.pg.click("#btEditar")
        self.pg.wait_for_timeout(700)
        return self.pg.evaluate(
            """() => [...document.querySelectorAll('#tbody tr[data-uid]')].map(tr => ({
                 uid: tr.dataset.uid, cls: tr.className,
                 campos: Object.fromEntries([...tr.querySelectorAll('input,select')]
                           .map(e => [e.dataset.c, e.value])) }))""")

    def gravar(self):
        self.pg.once("dialog", lambda d: d.accept())
        self.pg.click("#btAplicar")
        self.pg.wait_for_timeout(1600)

    def aPagar(self, chave):
        return self.pg.evaluate(
            "c => (SB_PAINEL.estado().contas.find(x => x.chave === c) || {}).aPagar", chave)

    def ajustes(self):
        return (self.estado.get("ajustes") or {}).get("2026-09-23", [])

    # ------------------------------------------------------------------ testes

    def test_0_sem_ajuste_o_total_recalculado_bate_com_o_do_etl(self):
        """A invariante que o recálculo assume, afirmada de verdade.

        O painel deixou de ler `a_pagar_por_conta` do arquivo e passou a somar os títulos,
        porque um ajuste muda a soma e o agregado do arquivo ficaria para trás. Isso só é
        seguro porque os dois saem da MESMA lista no ETL (`fatos_logic.gerar_fatos`).

        Havia um comentário dizendo isso e nenhum teste exigindo. Comentário não quebra o
        CI quando alguém mexe no ETL — asserção quebra.
        """
        self.abrir()
        for chave, esperado in self.FATOS["a_pagar_por_conta"].items():
            self.assertAlmostEqual(self.aPagar(chave), esperado, 2,
                                   f"{chave}: recálculo divergiu do agregado do ETL")

    def test_0b_arredonda_como_o_etl(self):
        """O ETL faz `round(soma, 2)`. Somando sem arredondar no fim, o painel carregaria
        o ruído de ponto flutuante que o arquivo não tem — dois números que a tela
        apresenta como o mesmo, diferindo em centavos."""
        fatos = json.loads(json.dumps(self.FATOS))
        # valores escolhidos para a soma binária não fechar redonda: 0.1+0.2 = 0.30000000000000004
        fatos["titulos"] = [
            dict(fatos["titulos"][0], valor=0.1),
            dict(fatos["titulos"][0], valor=0.2, vencimento="2026-09-25"),
        ]
        fatos["a_pagar_por_conta"] = {"LUXOR INVESTIMENTOS": 0.3}
        self.abrir(fatos=fatos)
        self.assertEqual(self.aPagar("LUXOR INVESTIMENTOS"), 0.3)

    def test_1_os_titulos_do_bimer_entram_na_edicao(self):
        pg = self.abrir()
        linhas = self.editar()
        self.assertEqual(len(linhas), len(self.FATOS["titulos"]))
        # o nº do título não se edita: é a `ref` que liga o ajuste, não o que está no campo
        self.assertTrue(pg.locator('#tbody tr input[data-c="titulo"]').first.is_disabled())

    def test_2_mudar_o_valor_muda_o_total_da_conta(self):
        self.abrir()
        linhas = self.editar()
        alvo = linhas[0]["uid"]
        antes = self.aPagar("LUXOR INVESTIMENTOS")

        self.pg.fill(f'tr[data-uid="{alvo}"] input[data-c=valor]', "2500")
        self.pg.dispatch_event(f'tr[data-uid="{alvo}"] input[data-c=valor]', "change")
        self.gravar()

        self.assertEqual(len(self.ajustes()), 1)
        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), antes - 1000 + 2500, 2)

    def test_3_remover_tira_da_projecao(self):
        self.abrir()
        linhas = self.editar()
        alvo = linhas[0]["uid"]
        antes = self.aPagar("LUXOR INVESTIMENTOS")

        self.pg.click(f'tr[data-uid="{alvo}"] button[data-del]')
        self.pg.wait_for_timeout(300)
        cls = self.pg.get_attribute(f'tr[data-uid="{alvo}"]', "class")
        self.assertIn("removido", cls, "a linha fica na tela, riscada, para dar desfazer")

        self.gravar()
        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), antes - 1000, 2)
        # continua NO ESTADO (para o editor achar) mas fora da tabela de títulos
        self.assertEqual(self.pg.evaluate("SB_PAINEL.estado().titulos.length"),
                         len(self.FATOS["titulos"]),
                         "a linha removida não some do estado — some da conta")
        self.assertEqual(
            self.pg.evaluate("() => document.querySelectorAll('#tbody tr').length"),
            len(self.FATOS["titulos"]) - 1,
            "mas não aparece na tabela de títulos")

    def test_3b_remover_e_desfazivel_DEPOIS_de_gravar(self):
        """Achado pelo Arthur na revisão do PR #10, rodando o SB_DADOS no node.

        A primeira versão DESCARTAVA a linha removida em `aplicarAjustes`. Ela não chegava
        a `D.titulos`, e como o editor lê de lá, o botão "Trazer de volta" — com ícone e
        tooltip próprios — nunca voltava a ser desenhado. Desfazer virava editar o
        app_state à mão ou esperar a quarta.
        """
        self.abrir()
        linhas = self.editar()
        cheio = self.aPagar("LUXOR INVESTIMENTOS")

        self.pg.click(f'tr[data-uid="{linhas[0]["uid"]}"] button[data-del]')
        self.gravar()
        gravado = json.loads(json.dumps(self.estado))
        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), cheio - 1000, 2)

        # sessão nova, como quem volta no dia seguinte
        self.pg.close()
        self.abrir(estado=gravado)
        linhas = self.editar()

        riscada = [l for l in linhas if "removido" in l["cls"]]
        self.assertEqual(len(riscada), 1,
                         "a linha removida tem de voltar ao editor, riscada")

        self.pg.click(f'tr[data-uid="{riscada[0]["uid"]}"] button[data-del]')
        self.pg.wait_for_timeout(300)
        self.assertNotIn(
            "removido",
            self.pg.get_attribute(f'tr[data-uid="{riscada[0]["uid"]}"]', "class"))

        self.gravar()
        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), cheio, 2,
                               "desfeito, o valor volta para a conta")
        self.assertEqual(self.ajustes(), [], "e o ajuste some do documento")

    def test_4_trocar_a_conta_move_o_valor(self):
        self.abrir()
        linhas = self.editar()
        alvo = linhas[0]["uid"]
        antes_lx = self.aPagar("LUXOR INVESTIMENTOS")
        antes_ta = self.aPagar("TARITUBA")

        self.pg.select_option(f'tr[data-uid="{alvo}"] select[data-c=chave]', "TARITUBA")
        self.gravar()

        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), antes_lx - 1000, 2)
        self.assertAlmostEqual(self.aPagar("TARITUBA"), antes_ta + 1000, 2)

    def test_5_o_ajuste_sobrevive_a_republicacao_do_etl(self):
        """A razão de existir do desenho. Editar o título direto se perderia aqui."""
        self.abrir()
        linhas = self.editar()
        self.pg.fill(f'tr[data-uid="{linhas[0]["uid"]}"] input[data-c=valor]', "7777")
        self.pg.dispatch_event(f'tr[data-uid="{linhas[0]["uid"]}"] input[data-c=valor]',
                               "change")
        self.gravar()
        esperado = self.aPagar("LUXOR INVESTIMENTOS")
        gravado = json.loads(json.dumps(self.estado))
        self.pg.close()

        novos = json.loads(json.dumps(self.FATOS))
        novos["meta"]["gerado_em"] = "29/09/2026 08:00"      # o ETL rodou de novo
        self.abrir(estado=gravado, fatos=novos)
        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), esperado, 2)

    def test_6_o_ajuste_gruda_na_linha_certa_entre_titulos_gemeos(self):
        """Dois títulos dividem o número e o fornecedor, mudando só vencimento e valor.
        Chave fraca aplicaria o ajuste no irmão — e o TOTAL bateria igual, escondendo o
        erro. Por isso a conferência é no título, não na soma."""
        self.abrir()
        linhas = self.editar()
        luz = [l for l in linhas if l["campos"]["titulo"] == "LIGHT2026"]
        self.assertEqual(len(luz), 2, "o cenário depende dos dois gêmeos")

        segundo = next(l for l in luz if l["campos"]["valor"] == "1200")
        self.pg.fill(f'tr[data-uid="{segundo["uid"]}"] input[data-c=valor]', "50")
        self.pg.dispatch_event(f'tr[data-uid="{segundo["uid"]}"] input[data-c=valor]',
                               "change")
        self.gravar()

        vals = self.pg.evaluate(
            """() => SB_PAINEL.estado().titulos
                 .filter(t => t.titulo === 'LIGHT2026')
                 .map(t => Math.abs(t.valor)).sort((a,b) => a-b)""")
        self.assertEqual(vals, [50, 800], f"o ajuste caiu na linha errada: {vals}")

    def test_6b_gravar_nao_apaga_ajuste_de_outra_sessao(self):
        """Achado pelo Arthur na segunda revisão do PR #10 — e é o defeito mais grave
        que apareceu nesta feature.

        `salvarProvisoes` substitui os ajustes da semana inteiros. A tela mandava só o
        DELTA desta sessão, medido contra `E.origem` — a foto de quando a edição abriu,
        que já vem com os ajustes aplicados. Um título ajustado ontem e não tocado hoje
        parecia intocado, ficava de fora da lista, e era apagado na gravação.

        Quem editasse a conta A desfazia o ajuste da conta B sem aviso, e o número voltava
        sozinho ao do ETL.

        Os 37 testes anteriores passavam contra isso: todos abrem, editam e gravam UMA
        vez. É o mesmo formato do defeito do CORS — o caminho estava coberto, a segunda
        volta não.
        """
        self.abrir()
        linhas = self.editar()

        # sessão 1: ajusta o ALUGUEL (LUXOR)
        aluguel = next(l for l in linhas if l["campos"]["pessoa"] == "ALUGUEL")
        self.pg.fill(f'tr[data-uid="{aluguel["uid"]}"] input[data-c=valor]', "500")
        self.pg.dispatch_event(f'tr[data-uid="{aluguel["uid"]}"] input[data-c=valor]',
                               "change")
        self.gravar()
        luxor_ajustado = self.aPagar("LUXOR INVESTIMENTOS")
        gravado = json.loads(json.dumps(self.estado))
        self.assertEqual(len(self.ajustes()), 1)
        self.pg.close()

        # sessão 2: mexe SÓ na RAÇÃO (Tarituba), sem encostar no ALUGUEL
        self.abrir(estado=gravado)
        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), luxor_ajustado, 2,
                               "o ajuste da sessão 1 tem de estar valendo ao abrir")
        linhas = self.editar()
        racao = next(l for l in linhas if l["campos"]["pessoa"] == "RACAO")
        self.pg.fill(f'tr[data-uid="{racao["uid"]}"] input[data-c=valor]', "700")
        self.pg.dispatch_event(f'tr[data-uid="{racao["uid"]}"] input[data-c=valor]',
                               "change")
        self.gravar()

        refs = {a["ref"].split("|")[0] for a in self.ajustes()}
        self.assertEqual(refs, {"LUXOR INVESTIMENTOS", "TARITUBA"},
                         f"os dois ajustes têm de continuar valendo: {self.ajustes()}")
        self.assertAlmostEqual(self.aPagar("LUXOR INVESTIMENTOS"), luxor_ajustado, 2,
                               "o ALUGUEL não podia voltar ao valor do ETL")
        self.assertAlmostEqual(self.aPagar("TARITUBA"), 700, 2)

    def test_6c_corrigir_saldo_nao_apaga_provisao(self):
        """Terceiro defeito do mesmo tipo, achado ao revisar a feature com a lente da
        "segunda volta" que o Arthur apontou.

        `salvar(linhas, provisoes)` fazia `provs[semana] = (provisoes || [])`. O formulário
        de saldos chama `salvar(linhas)`, sem o segundo argumento — então **corrigir um
        saldo apagava todas as provisões da semana**, levando junto o trabalho de outra
        pessoa, sem nada na tela dizendo.

        A distinção entre `undefined` ("não mexi") e `[]` ("apaguei todas") já estava
        escrita em `salvarProvisoes` para os ajustes, com comentário e tudo. Faltava aqui.
        Qualquer gravação que substitua uma lista inteira precisa dela.
        """
        estado = json.loads(json.dumps(self.ESTADO))
        estado["provisoes"] = {"2026-09-23": [
            {"chave": "TARITUBA", "descricao": "PROVISAO DE OUTRA PESSOA",
             "valor": 6330.0, "vencimento": "2026-09-25",
             "por": "alguem@luxor.com.br", "em": "2026-09-23T09:00:00Z"}]}
        self.abrir(estado=estado)

        # corrige um saldo pelo formulário, sem encostar nas provisões
        self.pg.click("#btEditarSaldos")
        self.pg.wait_for_timeout(800)
        self.pg.locator("input.sbf[data-campo=saldo]").first.fill("12.345,00")
        self.pg.click("#sbfSalvar")
        self.pg.wait_for_timeout(1600)

        provs = (self.estado.get("provisoes") or {}).get("2026-09-23", [])
        self.assertEqual(len(provs), 1,
                         "a provisão de outra pessoa não pode sumir ao corrigir um saldo")
        self.assertEqual(provs[0]["descricao"], "PROVISAO DE OUTRA PESSOA")

    def test_7_ajuste_so_e_gravado_quando_algo_mudou(self):
        """Entrar na edição e gravar sem mexer não pode encher o documento de ajustes
        'iguais ao original' — que ainda sobreviveriam a uma correção no Bimer,
        continuando a aplicar o valor de antes."""
        self.abrir()
        self.editar()
        self.pg.evaluate("document.getElementById('btAplicar').disabled = false")
        self.gravar()
        self.assertEqual(self.ajustes(), [])


class TestSaldosGravadosSemFatos(unittest.TestCase):
    """Saldos JÁ gravados e o ETL ainda sem publicar — o painel não pode morrer ao abrir.

    Visto em produção em 21/09: alguém informou os saldos na sexta (para testar), o ETL
    do saldo bancário só roda na terça, e na segunda o painel abriu no placeholder
    "Dados não carregados", sem mensagem nenhuma.

    A cadeia: todos os saldos preenchidos -> `faltando` vazio -> `completo` -> boot chama
    `render()` -> `D.janela[0]` com janela null. E `decidirTela()` está FORA do try do
    boot, então a exceção não vira mensagem: o placeholder do HTML fica na tela.

    Era invisível no teste anterior porque lá o formulário é preenchido DURANTE o teste;
    aqui a página já nasce com as entradas gravadas, que é o caso de quem só abre a tela.
    """

    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")

        cls.estado = json.loads(json.dumps(ESTADO_INICIAL))
        cls.erros = []

        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
        cls.pg = cls._b.new_page(viewport={"width": 1400, "height": 900})
        cls.pg.on("pageerror", lambda e: cls.erros.append(str(e)))

        def rota(route, request):
            if "/storage/v1/object/" in request.url:
                return route.fulfill(status=400, content_type="application/json",
                                     body=json.dumps({"statusCode": "404",
                                                      "message": "Object not found"}))
            if "/rest/v1/app_state" in request.url:
                return route.fulfill(status=200,
                                     content_type="application/vnd.pgrst.object+json",
                                     body=json.dumps({"data": cls.estado,
                                                      "updated_at": "2026-09-01"}))
            return route.continue_()

        cls.pg.route("**/*.supabase.co/**", rota)
        cls.pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")

        # Primeira carga só para perguntar ao painel qual é a semana corrente. Calcular a
        # quarta-feira aqui seria uma segunda implementação de `quartaDaSemana`, que
        # divergiria em silêncio justamente na virada da semana.
        cls.pg.goto((AQUI / "index.html").as_uri())
        cls.pg.wait_for_timeout(1300)
        semana = cls.pg.evaluate("SB_PAINEL.estado().semana")

        cls.estado["entradas"] = {semana: [
            {"chave": chave, "semana": semana,
             "saldo": float(v.replace(".", "").replace(",", ".")),
             "a_receber": 0, "por": "fulano@luxor.com.br",
             "em": "2026-09-18T12:00:00.000Z"}
            for chave, v in SALDOS.items()
        ]}
        cls.semana = semana

        cls.erros.clear()                      # só interessam os erros da carga real
        cls.pg.goto((AQUI / "index.html").as_uri())
        cls.pg.wait_for_timeout(1300)

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def test_1_a_tela_abriu(self):
        """O sintoma exato: o placeholder do HTML continuar na tela."""
        self.assertEqual(self.pg.locator("#semDados").count(), 0,
                         "o boot morreu antes de desenhar qualquer coisa")

    def test_2_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")

    def test_3_cai_no_formulario_e_diz_por_que(self):
        """Com saldo informado mas sem fatos, o certo é o formulário com o aviso — não a
        projeção, que fecharia as contas contra saída zero em toda conta."""
        pg = self.pg
        self.assertFalse(pg.evaluate("SB_PAINEL.estado().completo"))
        self.assertEqual(pg.locator("#sbfSalvar").count(), 1)
        self.assertIn("ainda não foram publicadas", pg.inner_text("body"))

    def test_4_o_que_ja_estava_gravado_continua_na_tela(self):
        """O formulário não pode aparecer vazio: quem digitou na semana passada tem de
        ver o que digitou, senão parece que a gravação se perdeu."""
        self.assertIn("20.000", self.pg.input_value(
            'input.sbf[data-campo=saldo][data-chave="LUXOR INVESTIMENTOS"]'))


class TestExportPdf(unittest.TestCase):
    """O PDF da tabela de Movimentações e das Sugestões.

    ABRIR NUM LEITOR NÃO PROVA QUE O ARQUIVO ESTÁ CERTO: o PDF é montado à mão, e um
    offset de `xref` errado por um byte faz alguns leitores reconstruírem em silêncio e
    outros recusarem. Por isso o teste tem duas metades — um lint da estrutura, byte a
    byte, e a conferência do conteúdo contra os mesmos números do painel.

    O clique NÃO é testado de propósito: baixar de verdade pendura o navegador headless
    (o download fica esperando destino e nunca volta). O teste chama `SB_PAINEL.pdf()`,
    que é a MESMA função que o botão usa, sem o passo de baixar.
    """

    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")

        estado = json.loads(json.dumps(ESTADO_INICIAL))
        # com os saldos já informados, o painel abre direto na projeção
        semana = "2026-09-09"
        estado["entradas"] = {semana: [
            {"chave": "LUXOR INVESTIMENTOS", "saldo": 20000.0},
            {"chave": "LUXOR PARTICIPAÇÃO - BTG", "saldo": 1204.44},
            {"chave": "TARITUBA", "saldo": 50000.0},
            {"chave": "Luxor Investimentos - Itau CDB-DI", "saldo": 856529.27},
            {"chave": "Luxor Participação - BTG Fundo Manga", "saldo": 44210.05},
            {"chave": "Luxor Participação - BTG Tesouro Selic", "saldo": 120334.87},
            {"chave": "Tarituba - Sicredi CDB-DI", "saldo": 48120.77},
            {"chave": "Tarituba - Outro Banco", "saldo": 15402.66},
        ]}

        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
        cls.pg = cls._b.new_page(viewport={"width": 1400, "height": 900})
        cls.erros = []
        cls.pg.on("pageerror", lambda e: cls.erros.append(str(e)))

        def rota(route, request):
            if "/storage/v1/object/" in request.url:
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps(FATOS))
            if "/rest/v1/app_state" in request.url:
                return route.fulfill(status=200,
                                     content_type="application/vnd.pgrst.object+json",
                                     body=json.dumps({"data": estado,
                                                      "updated_at": "v1"}))
            return route.continue_()

        cls.pg.route("**/*.supabase.co/**", rota)
        cls.pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
        cls.pg.goto((AQUI / "index.html").as_uri())
        cls.pg.wait_for_timeout(1500)

        # base64 porque o bridge do Playwright serializa JSON: um Uint8Array volta como
        # objeto indexado por string e os bytes altos se perdem na volta
        b64 = cls.pg.evaluate("""() => {
            const bytes = SB_PAINEL.pdf();
            let s = '';
            for (const b of bytes) s += String.fromCharCode(b);
            return btoa(s);
        }""")
        cls.bytes = base64.b64decode(b64)

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    # ---------------- lint da estrutura ----------------

    def test_1_o_botao_existe_no_painel(self):
        self.assertEqual(self.pg.locator("#btPdf").count(), 1,
                         "sem o botão, o exportador existe e ninguém alcança")
        self.assertEqual(self.erros, [])

    def test_2_e_um_pdf(self):
        self.assertTrue(self.bytes.startswith(b"%PDF-1.4"), self.bytes[:20])
        self.assertTrue(self.bytes.rstrip().endswith(b"%%EOF"), self.bytes[-20:])

    def test_3_os_offsets_do_xref_apontam_para_os_objetos(self):
        """Byte a byte. Um offset errado é o defeito que não aparece ao abrir: o leitor
        reconstrói o índice em silêncio, e só falha em outro leitor — ou na impressora."""
        b = self.bytes
        ini = b.rindex(b"startxref")
        inicio_xref = int(b[ini + 9:].split(b"%%EOF")[0].strip())
        self.assertEqual(b[inicio_xref:inicio_xref + 4], b"xref",
                         "startxref não aponta para a tabela xref")

        linhas_x = b[inicio_xref:].split(b"\n")
        total = int(linhas_x[1].split()[1])
        for i in range(1, total):
            campo = linhas_x[1 + i + 1]          # pula "xref", o cabeçalho e o objeto 0
            desl = int(campo.split()[0])
            esperado = b"%d 0 obj" % i
            self.assertEqual(b[desl:desl + len(esperado)], esperado,
                             f"objeto {i}: o xref aponta para {b[desl:desl+20]!r}")

    def test_4_o_length_de_cada_stream_bate_com_o_conteudo(self):
        """`/Length` menor corta o desenho no meio; maior faz o leitor ler lixo. Os dois
        casos abrem sem erro em algum leitor e quebram em outro."""
        b, i, achou = self.bytes, 0, 0
        while True:
            i = b.find(b"<< /Length ", i)
            if i < 0:
                break
            declarado = int(b[i + 11:b.index(b" >>", i)])
            ini = b.index(b"stream\n", i) + 7
            fim = b.index(b"\nendstream", ini)
            self.assertEqual(fim - ini, declarado, "stream com /Length errado")
            achou += 1
            i = fim
        self.assertGreaterEqual(achou, 2, "esperava ao menos uma página e a de sugestões")

    def test_5_o_count_bate_com_as_paginas_reais(self):
        b = self.bytes
        declarado = int(b[b.index(b"/Count ") + 7:].split(b" ")[0].split(b">")[0])
        self.assertEqual(declarado, b.count(b"/Type /Page\n") + b.count(b"/Type /Page "),
                         "/Count diverge do número de objetos /Page")

    def test_6_nao_ha_utf8_cru(self):
        """As fontes base-14 são WinAnsi, um byte por caractere. UTF-8 vazando vira dois
        caracteres estranhos na página — e o teste que olha só o `get_text` não pega,
        porque o extrator reconstrói."""
        for trecho in self.bytes.split(b"stream\n")[1:]:
            corpo = trecho.split(b"\nendstream")[0]
            self.assertNotIn("ção".encode("utf-8"), corpo,
                             "texto em UTF-8 dentro do stream")

    def test_7_q_e_Q_balanceados(self):
        """`q` sem `Q` deixa o clip valendo para o resto da página: o texto seguinte some
        sem deixar rastro no arquivo."""
        for trecho in self.bytes.split(b"stream\n")[1:]:
            corpo = trecho.split(b"\nendstream")[0]
            self.assertEqual(corpo.count(b" q "), 0, "q solto no meio da linha")
            abre = sum(1 for l in corpo.split(b"\n") if l.startswith(b"q "))
            fecha = sum(1 for l in corpo.split(b"\n") if l.endswith(b" Q"))
            self.assertEqual(abre, fecha, "q e Q desbalanceados")

    # ---------------- conteúdo ----------------

    def _texto(self):
        try:
            import fitz
        except ImportError:
            raise unittest.SkipTest("PyMuPDF não instalado")
        doc = fitz.open(stream=self.bytes, filetype="pdf")
        return doc, [p.get_text() for p in doc]

    def test_8_a_tabela_e_as_sugestoes_em_paginas_separadas(self):
        """Decisão do Leonardo (30/09/2026): a tabela numa folha e os cards na outra."""
        doc, paginas = self._texto()
        self.assertGreaterEqual(doc.page_count, 2)
        self.assertIn("Total em conta corrente", paginas[-2])
        self.assertNotIn("Sugestões de Movimentação", paginas[-2],
                         "as sugestões não podem vazar para a página da tabela")
        self.assertIn("Sugestões de Movimentação", paginas[-1])
        self.assertNotIn("Total em conta corrente", paginas[-1])

    def test_9_os_numeros_sao_os_da_tela(self):
        """O PDF recebe o mesmo `escopo()` da tabela, então o teste é contra o ESTADO do
        painel — não contra números escritos à mão aqui, que envelheceriam junto."""
        _, paginas = self._texto()
        tudo = "\n".join(paginas).replace("\xa0", " ")
        contas = self.pg.evaluate("() => window.SB_PAINEL.estado().contas")

        def brl(v):
            return ("-" if v < 0 else "") + "R$ " + f"{abs(v):,.2f}".replace(
                ",", "@").replace(".", ",").replace("@", ".")

        for c in contas:
            with self.subTest(conta=c["chave"]):
                self.assertIn(c["conta"], tudo, "conta ausente do PDF")
                self.assertIn(brl(c["saldo"]), tudo, "saldo ausente")
                self.assertIn(brl(c["restante"]), tudo, "saldo restante ausente")

    def test_10_toda_conta_com_acao_vira_um_cartao(self):
        _, paginas = self._texto()
        sug = paginas[-1]
        contas = self.pg.evaluate("() => window.SB_PAINEL.estado().contas")
        com_acao = [c for c in contas if c.get("acao")]
        self.assertTrue(com_acao, "pré-condição: o cenário tem movimentação sugerida")
        for c in com_acao:
            with self.subTest(conta=c["chave"]):
                self.assertIn(c["conta"], sug)
                self.assertIn(c["valor_rotulo"], sug)
        # a palavra, e não só a cor: pode ser impresso em preto e branco
        self.assertTrue("RESGATAR" in sug or "APLICAR" in sug)

    def test_11_nao_vaza_undefined_nem_o_lixo_dos_sinais(self):
        """`—` e `−` não existem em WinAnsi. Passando direto, saem como outro caractere —
        e um traço que virou outra coisa num relatório de caixa é ruído no lugar errado."""
        _, paginas = self._texto()
        tudo = "\n".join(paginas)
        self.assertNotIn("undefined", tudo)
        self.assertNotIn("NaN", tudo)
        self.assertNotIn("└", tudo, "o └ da tela não pode ir para o papel")

    def test_13_conta_sem_investimento_par_nao_ganha_preposicao(self):
        """Classe própria porque a fixture do resto TEM investimento par, e este defeito
        só existe sem ele — dentro do `test_11` a asserção passava com o defeito presente,
        que é pior do que não ter teste.

        O cartão colava a preposição no texto de ausência: "no sem investimento par", ou
        "do sem investimento par" num resgate. Hoje nenhuma conta ativa está sem par, então
        seria a primeira conta nova a levar isso para o papel que vai à conversa com o
        banco. A tabela já escrevia certo — era só o cartão.
        """
        estado = json.loads(json.dumps(ESTADO_INICIAL))
        for c in estado["contas"]:
            c["investimentos"] = []          # nenhuma tem par: todo cartão cai no fallback
        semana = "2026-09-09"
        estado["entradas"] = {semana: [
            {"chave": c["chave"], "saldo": 20000.0} for c in estado["contas"]]}

        # PÁGINA nova no navegador da classe: abrir um segundo `sync_playwright`
        # dentro dela estoura ("Sync API inside the asyncio loop").
        pg = type(self)._b.new_page(viewport={"width": 1400, "height": 900})
        try:
            def rota(route, request):
                if "/storage/v1/object/" in request.url:
                    return route.fulfill(status=200, content_type="application/json",
                                         body=json.dumps(FATOS))
                if "/rest/v1/app_state" in request.url:
                    return route.fulfill(
                        status=200,
                        content_type="application/vnd.pgrst.object+json",
                        body=json.dumps({"data": estado, "updated_at": "v1"}))
                return route.continue_()

            pg.route("**/*.supabase.co/**", rota)
            pg.add_init_script("window.HUB = {email:'fulano@luxor.com.br'};")
            pg.goto((AQUI / "index.html").as_uri())
            pg.wait_for_timeout(1500)
            b64 = pg.evaluate("""() => {
                const bytes = SB_PAINEL.pdf();
                let s = '';
                for (const b of bytes) s += String.fromCharCode(b);
                return btoa(s);
            }""")
        finally:
            pg.close()

        try:
            import fitz
        except ImportError:
            raise unittest.SkipTest("PyMuPDF não instalado")
        doc = fitz.open(stream=base64.b64decode(b64), filetype="pdf")
        texto = "\n".join(p.get_text() for p in doc)
        doc.close()

        self.assertIn("sem investimento par", texto,
                      "a fixture precisa ter cartão sem par, senão o teste não prova nada")
        for prep in ("no sem investimento par", "do sem investimento par"):
            self.assertNotIn(prep, texto, "preposição colada no texto de ausência")

    def test_12_a_procedencia_vai_junto(self):
        """Um PDF circula solto: sem a janela e a ressalva, alguém lê os números daqui a
        um mês sem saber de quando são nem que não movimentam dinheiro."""
        _, paginas = self._texto()
        for i, p in enumerate(paginas):
            with self.subTest(pagina=i + 1):
                self.assertIn("Saldo Bancário", p)
                self.assertIn("09/09/2026 a 16/09/2026", p, "a janela em toda página")
                self.assertIn("não movimenta dinheiro", p)


if __name__ == "__main__":
    unittest.main(verbosity=2)
