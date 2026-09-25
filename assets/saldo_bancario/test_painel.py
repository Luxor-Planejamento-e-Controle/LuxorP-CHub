"""Testa o painel de Saldo Bancário com o supabase-js REAL e a rede interceptada.

Por que interceptar HTTP em vez de trocar `window.supabase`: o painel cria o client no
primeiro carregamento e o mantém em cache, então substituir o objeto depois não tem
efeito. Interceptando as requisições, o supabase-js real roda — o que também testa se as
chamadas que escrevemos (storage.download, app_state select/update) produzem as
requisições certas.

Roda sem credencial, sem sessão e sem tocar no Supabase de verdade.

Uso: python assets/saldo_bancario/test_painel.py   (da raiz do repo do hub)
"""

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
         "banco": "BTG", "colchao": 0, "ativa": True, "a_receber_fixo": 25000,
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

    def test_1d_entrada_fixa_vem_preenchida_do_cadastro(self):
        """Na planilha a provisão recorrente era uma linha parada na Base CAR, e alguém
        só empurrava a data toda quarta. Exigir que fosse redigitada aqui seria trocar
        uma redigitação por outra."""
        pg = self.pg
        sel = 'input.sbf[data-campo=a_receber][data-chave="LUXOR PARTICIPAÇÃO - BTG"]'
        self.assertEqual(pg.input_value(sel), "R$ 25.000,00")
        self.assertIn("do cadastro", pg.inner_text("body"))

        # conta sem entrada fixa continua vazia: o valor é de uma conta, não de todas
        self.assertEqual(pg.input_value(
            'input.sbf[data-campo=a_receber][data-chave="LUXOR INVESTIMENTOS"]'), "")

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
        # entrada prevista: não vem de sistema nenhum e não tem data — é o que obriga o
        # fluxo dia a dia a colocá-la em algum dia para fechar com o saldo restante
        pg.fill('input.sbf[data-campo=a_receber][data-chave="TARITUBA"]', "5.000,00")
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

        # 20.000 − 14.033,78 = 5.966,22 ; colchão 30.000 → resgatar 25k (degrau de 5k)
        li = por["LUXOR INVESTIMENTOS"]
        self.assertAlmostEqual(li["restante"], 5966.22, places=2)
        self.assertEqual(li["acao"], "resgate")
        self.assertEqual(li["valor"], 25000)
        self.assertEqual(li["par_nome"], "Luxor Investimentos - Itau CDB-DI")
        self.assertEqual(li["par_saldo"], 856529.27)

        # 50.000 − 149,90 + 5.000 = 54.850,10 ; colchão 10.000 → aplicar 40k
        t = por["TARITUBA"]
        self.assertAlmostEqual(t["restante"], 54850.10, places=2)
        self.assertEqual(t["acao"], "Aplicar")
        self.assertEqual(t["valor"], 40000)

        # colchão 0 com sobra: conta em descontinuação não recebe aplicação
        btg = por["LUXOR PARTICIPAÇÃO - BTG"]
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

    def test_7b_semana_informada_respeita_o_campo_vazio(self):
        """Numa semana em que a entrada não vai acontecer, limpar o campo tem de valer.
        Se o valor do cadastro voltasse sozinho, a projeção contaria dinheiro que
        ninguém espera — e ninguém entenderia por quê."""
        pg = self.pg
        pg.click("#btEditarSaldos")
        pg.wait_for_timeout(500)
        sel = 'input.sbf[data-campo=a_receber][data-chave="LUXOR PARTICIPAÇÃO - BTG"]'
        pg.fill(sel, "")
        pg.click("#sbfSalvar")
        pg.wait_for_timeout(1100)

        por = {c["chave"]: c for c in
               pg.evaluate("() => window.SB_PAINEL.estado().contas")}
        self.assertEqual(por["LUXOR PARTICIPAÇÃO - BTG"]["aReceber"], 0,
                         "campo limpo depois de informado vale zero")

        pg.click("#btEditarSaldos")
        pg.wait_for_timeout(500)
        self.assertEqual(pg.input_value(sel), "",
                         "e continua vazio ao reabrir — o fixo não volta por cima")
        self.assertNotIn("do cadastro", pg.inner_text("body"))
        pg.click("#sbfVoltar")
        pg.wait_for_timeout(400)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
