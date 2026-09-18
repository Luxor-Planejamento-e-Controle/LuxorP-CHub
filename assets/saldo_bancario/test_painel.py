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
                cls.gravacoes.append(json.loads(request.post_data))
                cls.estado = cls.gravacoes[-1]["data"]
                return route.fulfill(status=200, content_type="application/json", body="[]")
            if "/rest/v1/app_state" in url:
                # maybeSingle() pede objeto único (Accept: application/vnd.pgrst.object+json)
                return route.fulfill(status=200,
                                     content_type="application/vnd.pgrst.object+json",
                                     body=json.dumps({"data": cls.estado}))
            return route.continue_()

        cls.pg.route("**/*.supabase.co/**", rota)
        cls.pg.add_init_script("window.HUB = {email:'leonardo.fernandes@luxor.com.br'};")
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
                         "leonardo.fernandes@luxor.com.br", "registra quem digitou")
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
        # sem provisão, a tabela mostra só a linha de estado vazio — e NENHUM título do
        # Bimer, que é o ponto: eles não são editáveis daqui
        self.assertEqual(pg.locator('#tbody tr[data-uid]').count(), 0,
                         "começa sem provisão — e o título do Bimer NÃO entra aqui")

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

    def test_9_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
