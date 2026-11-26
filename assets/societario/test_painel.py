"""Testa a aba Estruturas Societárias com o supabase-js REAL e o bot interceptado.

A sessão do hub é semeada no localStorage (o supabase-js a lê sem ir à rede) e as
chamadas ao bot (*.azurecontainerapps.io) são atendidas aqui — o que também confere
que a página manda o token e pede as rotas certas.

Dado SINTÉTICO (nomes, CNPJs e valores inventados): o repositório é público.

Uso: python assets/societario/test_painel.py   (da raiz do repo do hub)
"""
import base64
import json
from datetime import date, timedelta
import pathlib
import time
import unittest
import urllib.parse

AQUI = pathlib.Path(__file__).resolve().parent
TOKEN = "token-de-teste"
# PNG 1×1 válido, para o <img> carregar de verdade
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")

DADOS = {
    "generated_at": "2026-11-12T17:00:00",
    "companies": [
        {"key": "alfa", "name": "Alfa Holding S.A.", "short_name": "Alfa", "type": "S.A.", "cnpj": "00.000.000/0001-00",
         "capital_social": "R$ 1.000,00", "position_date": "2026-03-03", "source": "Ata Alfa.pdf",
         "documents": ["Ata Alfa.pdf", "Estatuto Alfa.pdf"],
         "shareholders": [{"name": "Pessoa Um", "kind": "PF", "percent": 60.0, "shares": "600 ações"},
                          {"name": "Pessoa Dois", "kind": "PF", "percent": 40.0, "shares": "400 ações"}],
         "former_shareholders": [{"name": "Pessoa Antiga", "until": "2024-01-02", "how": "cessão", "source": "Ata 2024.pdf"}]},
        {"key": "beta", "name": "Beta Ltda.", "short_name": "Beta", "type": "Ltda.", "position_date": "2025-01-10",
         "documents": ["Contrato Beta.pdf"],
         "shareholders": [{"name": "Alfa Holding S.A.", "kind": "PJ", "company_key": "alfa", "percent": 50.0},
                          {"name": "Pessoa Dois", "kind": "PF", "percent": 50.0}]},
        {"key": "gama", "name": "Gama", "short_name": "Gama", "no_documents": True, "shareholders": []},
    ],
    "investors": [
        {"id": "ext:PESSOA DOIS", "name": "Pessoa Dois", "kind": "PF", "cnpj": None,
         "direct": [{"company_key": "alfa", "percent": 40.0, "calculated": False, "shares": "400 ações"},
                    {"company_key": "beta", "percent": 50.0, "calculated": False, "shares": None}],
         "indirect": [{"company_key": "beta", "percent": 20.0, "calculated": True, "path": ["Pessoa Dois", "Alfa", "Beta"]}]},
        {"id": "ext:PESSOA UM", "name": "Pessoa Um", "kind": "PF", "cnpj": None,
         "direct": [{"company_key": "alfa", "percent": 60.0, "calculated": False, "shares": "600 ações"}],
         "indirect": [{"company_key": "beta", "percent": 30.0, "calculated": True, "path": ["Pessoa Um", "Alfa", "Beta"]}]},
    ],
}
PROC = {"documents_total": 6, "documents_pending": 2, "documents_failed": 0, "refreshing": True,
        "updated_at": "2026-11-13T10:00:00-03:00",
        "items": [
            {"chave": "beta|PESSOA TRES|2026-11-01|2025-01-01", "company_key": "beta", "company": "Beta", "outorgado": "Pessoa Três", "outorgante": "Beta Ltda.",
             "data_outorga": "2025-01-01", "data_vencimento": "2026-11-01", "poderes": "bancos e INSS",
             "dias": -12, "status": "vencida", "documents": ["Ata outorga.pdf", "Ata outorga - REGISTRADA.pdf"]},
            {"chave": "alfa|PESSOA UM|2026-11-20|", "company_key": "alfa", "company": "Alfa", "outorgado": "Pessoa Um", "outorgante": "Alfa Holding S.A.",
             "data_outorga": None, "data_vencimento": "2026-11-20", "poderes": "receita federal",
             "dias": 7, "status": "vence_7", "documents": ["Procuração DP1.pdf"]},
            {"chave": "alfa|PESSOA DOIS|2027-06-01|2025-06-01", "company_key": "alfa", "company": "Alfa", "outorgado": "Pessoa Dois", "outorgante": "Alfa Holding S.A.",
             "data_outorga": "2025-06-01", "data_vencimento": "2027-06-01", "poderes": "<b>tudo</b>",
             "dias": 200, "status": "vigente", "documents": ["Procuração DP1.pdf"]},
        ]}
ADV = {"arquivo": "Listagem Advogados Parceiros.xlsx", "atualizado_em": "2026-11-13T15:00:00-03:00",
       "escritorios": [
           {"nome": "ALFA ADVOGADOS", "documento": "00.000.000/0001-00", "area": "Trabalhista",
            "indicacao": "Indicação <img src=x onerror=window.pwned=3>", "processos": ["Reclamação X"],
            "advogados": [{"nome": "Pessoa Um", "telefone": "21 9999-0001", "email": "um@alfa.adv.br", "processo": None},
                          {"nome": "Pessoa Dois", "telefone": "21 9999-0002", "email": "dois@alfa.adv.br", "processo": None}]},
           {"nome": "BETA ADVOCACIA", "documento": "11.111.111/0001-11", "area": "Tributário Rio", "indicacao": None,
            "processos": [], "advogados": [{"nome": "Pessoa Três", "telefone": None, "email": "tres@beta.adv.br",
                                            "processo": "ITBI imóvel A"}]},
           {"nome": "BETA ADVOCACIA", "documento": "11.111.111/0001-11", "area": "Tributário SP", "indicacao": None,
            "processos": [], "advogados": [{"nome": "Pessoa Quatro", "telefone": "11 9999-0004", "email": None,
                                            "processo": None}]},
       ]}
PROCS = {"arquivo": "Processos em andamento.xlsx", "atualizado_em": "2026-11-13T16:00:00-03:00", "andamentos_configurado": True,
         "processos": [
             {"id": "P-0001", "documento": "00.000.000/0001-00", "situacao": "Ativo", "numero_cnj": True,
              "tipo": "Processo Judicial", "esfera": "Federal", "data_inicio": "2025-08-08", "observacoes": "Solicitamos perícia",
              "andamento_cnj": {"encontrado": True, "tribunal": "TRT1", "classe": "Ação Trabalhista", "orgao": "1ª Vara do Trabalho",
                                "consultado_em": "2026-11-16T08:00:00-03:00",
                                "movimentos": [{"data": "2026-11-12T10:30:00", "nome": "Audiência designada"},
                                               {"data": "2026-10-01T09:00:00", "nome": "Citação"}]},
              "numero": "0000001-00.2025.5.01.0001", "empresa": "Empresa Alfa", "polo": "Réu", "parte_contraria": "Pessoa X",
              "area": "Trabalhista", "objeto": "Reclamação trabalhista", "tribunal": "1ª Vara do Trabalho RJ",
              "escritorio": "BETA ADVOCACIA", "advogado": "Pessoa Três", "valor_causa": 150000.5, "risco": "Provável",
              "fase": "Instrução", "ultima_movimentacao": "Audiência redesignada", "data_ultima_movimentacao": "2026-11-03",
              "proximo_prazo": "Audiência de instrução", "data_proximo_prazo": (date.today() + timedelta(days=3)).isoformat(),
              "linha": 2},
             {"id": "P-0002", "documento": None, "situacao": "Inativo", "numero_cnj": False, "andamento_cnj": None,
              "tipo": "PerdComp", "esfera": "Estadual",
              "numero": None, "empresa": "Empresa Beta", "polo": "Autor", "parte_contraria": None, "area": "Tributário",
              "objeto": "Recuperação de ICMS <b>x</b>", "tribunal": None, "escritorio": "ALFA ADVOGADOS", "advogado": None,
              "valor_causa": None, "risco": "Remoto", "fase": None, "ultima_movimentacao": None,
              "data_ultima_movimentacao": None, "proximo_prazo": None, "data_proximo_prazo": None, "linha": 3},
         ]}
MANIFEST = {"generated_at": "2026-11-12T17:33:55-03:00", "charts": 3,
            "files": ["Organogramas Grupo.pdf", "1 Grupo/Grupo.png", "2 Por empresa/Alfa.png", "2 Por empresa/Beta.png"]}


class Bot:
    """O que o bot devolve, mutável durante o teste."""
    def __init__(self):
        self.pedidos = []          # (método, caminho, Authorization, corpo)
        self.resposta = {"company": "Alfa", "text": "*Alfa* tem _dois_ sócios.\n• Pessoa Um — 60%",
                         "image": base64.b64encode(PNG).decode(), "sources": ["Ata Alfa.pdf"],
                         "files": [{"name": "Organogramas Grupo.pdf", "title": "Todos", "size": 4,
                                    "data": base64.b64encode(b"%PDF").decode()}]}
        self.status = 200
        self.processos_ok = True    # o que hub_can('processos') responde no Supabase
        self.envio_ok = True        # idem para hub_can('societario_envio')
        self.envio_status = 200
        self.envios = []            # (query, corpo) dos POST /hub/documentos
        self.posts = []             # (caminho, query, corpo) dos demais POST de cadastro
        self.previa = {}             # resposta do /importar?confirmar=0, por tipo
        self.anexos = {("advogados", "ALFA ADVOGADOS"): [{"nome": "Contrato.pdf", "tamanho": 4, "enviado_em": "2026-11-16T10:00:00-03:00"}]}
        self.segurar = False     # True: guarda a rota do /hub/ask e só responde quando o teste mandar
        self.procs = PROCS       # o que GET /hub/processos devolve (o teste troca depois de gravar)
        self.espelhado = False   # o bot já gravou a planilha na pasta que ele lê
        self.pendente = None


def _abrir(cls, bot, secao=""):
    from playwright.sync_api import sync_playwright

    cls = type(cls)
    if not hasattr(cls, "_pw"):
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
    erros = []
    pg = cls._b.new_page(viewport={"width": 1500, "height": 900})
    pg.on("pageerror", lambda e: erros.append(str(e)))
    cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, POST"}

    def rota(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=200, headers=cors)
        u = urllib.parse.urlparse(request.url)
        bot.pedidos.append((request.method, u.path + ("?" + u.query if u.query else ""),
                            request.headers.get("authorization"), request.post_data))
        if bot.status != 200:
            return route.fulfill(status=bot.status, headers=cors, content_type="application/json",
                                 body=json.dumps({"error": "Você não tem acesso à aba Estruturas Societárias."}))
        if u.path == "/hub/ask":
            if bot.segurar:
                bot.pendente = (route, cors)
                return None
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(bot.resposta))
        if u.path == "/hub/dados":
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(DADOS))
        if u.path == "/hub/procuracoes":
            corpo = dict(PROC)
            if "excluidas=1" in u.query:
                corpo["items"] = PROC["items"] + [dict(PROC["items"][0], chave="x|VELHA|2020-01-01|", outorgado="Pessoa Velha",
                                                       excluida=True, data_vencimento="2020-01-01", dias=-2000)]
            corpo["excluidas"] = 1
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(corpo))
        if request.method == "POST" and u.path not in ("/hub/ask", "/hub/documentos"):
            q = urllib.parse.parse_qs(u.query)
            bruto = u.path == "/hub/anexos" or u.path.endswith("/importar")
            corpo = request.post_data_buffer if bruto else json.loads(request.post_data or "{}")
            bot.posts.append((u.path, q, corpo))
            resp = {"ok": True, "commit": "c1", "espelhado": bot.espelhado}
            if u.path == "/hub/empresas":
                resp["pasta"] = corpo["nome"]
            if u.path == "/hub/processos":
                resp["id"] = "P-0099"
            if u.path == "/hub/anexos":
                resp["arquivo"] = q["nome"][0]
            if u.path.endswith("/importar"):
                resp.update(bot.previa[u.path.split("/")[2]], previa=q.get("confirmar") == ["0"])
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(resp))
        if u.path == "/hub/anexos":
            q = urllib.parse.parse_qs(u.query)
            itens = bot.anexos.get((q["tipo"][0], q["chave"][0]), [])
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(itens))
        if u.path in ("/hub/anexos/arquivo", "/hub/documentos/arquivo"):
            return route.fulfill(status=200, headers=cors, content_type="application/pdf", body=b"%PDF-baixado")
        if u.path == "/hub/documentos":
            bot.envios.append((urllib.parse.parse_qs(u.query), request.post_data_buffer))
            if bot.envio_status != 200:
                return route.fulfill(status=bot.envio_status, headers=cors, content_type="application/json",
                                     body=json.dumps({"error": "Já existe um documento com esse nome em Alfa."}))
            nome = urllib.parse.parse_qs(u.query)["nome"][0]
            return route.fulfill(status=200, headers=cors, content_type="application/json",
                                 body=json.dumps({"ok": True, "pasta": "Alfa", "arquivo": nome, "caminho": "c",
                                                  "commit": "abc", "commit_url": "u"}))
        if u.path == "/hub/processos":
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(bot.procs))
        if u.path == "/hub/advogados":
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(ADV))
        if u.path == "/hub/organogramas":
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(MANIFEST))
        if u.path == "/hub/organogramas/arquivo":
            arq = urllib.parse.parse_qs(u.query)["path"][0]
            if arq not in MANIFEST["files"]:
                return route.fulfill(status=404, headers=cors, content_type="application/json", body="{}")
            return route.fulfill(status=200, headers=cors, body=b"%PDF" if arq.endswith(".pdf") else PNG,
                                 content_type="application/pdf" if arq.endswith(".pdf") else "image/png")
        return route.fulfill(status=404, headers=cors, body="")

    pg.route("**/*.azurecontainerapps.io/**", rota)

    def supa(route, request):
        if "/rest/v1/rpc/hub_can" in request.url:
            dash = json.loads(request.post_data or "{}").get("dash")
            ok = {"processos": bot.processos_ok, "societario_envio": bot.envio_ok}.get(dash, True)
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(ok))
        return route.fulfill(status=404, headers=cors, body="")
    pg.route("**/*.supabase.co/**", supa)
    sessao = {"access_token": TOKEN, "refresh_token": "r", "token_type": "bearer", "expires_in": 3600,
              "expires_at": int(time.time()) + 3600, "user": {"id": "u1", "email": "teste@exemplo.com", "aud": "authenticated"}}
    pg.add_init_script(f"localStorage.setItem('sb-hjducsxcolbspbkpflom-auth-token', {json.dumps(json.dumps(sessao))});")
    pg.goto((AQUI / "index.html").as_uri() + (f"#{secao}" if secao else ""))
    pg.wait_for_timeout(600)
    return pg, erros


class TestAbaSocietario(unittest.TestCase):
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

    def test_1_chat_manda_o_token_e_mostra_a_resposta(self):
        bot = Bot()
        pg, erros = _abrir(self, bot)
        pg.fill("#pergunta", "Quem são os sócios da Alfa?")
        pg.press("#pergunta", "Enter")
        pg.wait_for_selector(".so-msg.bot .quem")
        metodo, caminho, auth, corpo = bot.pedidos[-1]
        self.assertEqual((metodo, caminho, auth), ("POST", "/hub/ask", f"Bearer {TOKEN}"))
        self.assertEqual(json.loads(corpo), {"question": "Quem são os sócios da Alfa?"})
        msg = pg.locator(".so-msg.bot").last
        self.assertEqual(msg.locator("strong").first.inner_text(), "Alfa")
        self.assertEqual(msg.locator("em").inner_text(), "dois")
        self.assertTrue(pg.evaluate("document.querySelector('.so-msg.bot img').naturalWidth") > 0)
        self.assertEqual(msg.locator("button[data-arq]").inner_text(), "Organogramas Grupo.pdf")
        self.assertIn("Fontes (1)", msg.locator("summary").inner_text())
        self.assertEqual(pg.locator(".so-msg.eu").inner_text(), "Quem são os sócios da Alfa?")
        self.assertEqual(erros, [])

    def test_2_texto_do_bot_nao_vira_html(self):
        bot = Bot()
        bot.resposta = {"company": "<b>x</b>", "text": "<img src=x onerror=\"window.pwned=1\"> *ok*",
                        "image": None, "files": [], "sources": ["<script>window.pwned=2</script>"]}
        pg, erros = _abrir(self, bot)
        pg.fill("#pergunta", "teste")
        pg.click("#enviar")
        pg.wait_for_selector(".so-msg.bot .quem")
        pg.wait_for_timeout(300)
        self.assertIsNone(pg.evaluate("window.pwned"))
        self.assertEqual(pg.locator(".so-msg.bot img").count(), 0)
        self.assertIn("<img src=x", pg.locator(".so-msg.bot").inner_text())
        self.assertEqual(pg.locator(".so-msg.bot .quem").inner_text(), "<B>X</B>")   # caixa alta do CSS
        self.assertEqual(erros, [])

    def test_3_sem_acesso_mostra_o_motivo(self):
        bot = Bot()
        bot.status = 403
        pg, erros = _abrir(self, bot)
        pg.fill("#pergunta", "oi")
        pg.press("#pergunta", "Enter")
        pg.wait_for_selector(".so-msg.bot.erro")
        self.assertIn("não tem acesso", pg.locator(".so-msg.bot.erro").inner_text())
        self.assertFalse(pg.is_disabled("#enviar"))
        self.assertEqual(erros, [])

    def test_4_espera_mostra_o_tempo_e_trava_o_envio(self):
        bot = Bot()
        bot.segurar = True
        pg, erros = _abrir(self, bot)
        pg.fill("#pergunta", "demora")
        pg.press("#pergunta", "Enter")
        pg.wait_for_selector(".so-pensando")
        self.assertTrue(pg.is_disabled("#enviar"))
        pg.wait_for_function("/Buscando a resposta… [1-9]s/.test(document.querySelector('.so-pensando').textContent)")
        route, cors = bot.pendente
        route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(bot.resposta))
        pg.wait_for_selector(".so-msg.bot .quem", timeout=8000)
        self.assertFalse(pg.is_disabled("#enviar"))
        self.assertEqual(erros, [])

    def test_5_organogramas_por_secao(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "organogramas")
        pg.wait_for_selector("#orgVer img")
        self.assertEqual(pg.locator("#orgSecoes button").all_inner_texts(), ["Grupo", "Por empresa"])
        self.assertIn("3 organogramas · gerados em 12/11/2026 17:33", pg.inner_text("#v-organogramas"))
        pg.click("#orgSecoes button:has-text('Por empresa')")
        pg.click(".so-lista button:has-text('Beta')")
        pg.wait_for_function("document.querySelector('#orgVer h2') && document.querySelector('#orgVer h2').textContent === 'Beta'")
        pg.wait_for_selector("#orgVer img")
        pedidos = [c for m, c, a, _ in bot.pedidos]
        self.assertIn("/hub/organogramas/arquivo?path=2+Por+empresa%2FBeta.png".replace("+", "%20"), pedidos)
        self.assertTrue(all(a == f"Bearer {TOKEN}" for _, _, a, _ in bot.pedidos))
        pg.fill("#orgBusca", "alf")
        self.assertEqual(pg.locator(".so-lista button").all_inner_texts(), ["Alfa"])
        self.assertEqual(pg.locator("#orgPdf").count(), 1)
        self.assertEqual(erros, [])

    def test_6_empresa_mostra_ficha_e_leva_ao_investidor(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "empresas")
        pg.wait_for_selector(".so-ficha h2")
        ficha = pg.inner_text(".so-ficha")
        for trecho in ("Alfa Holding S.A.", "00.000.000/0001-00", "R$ 1.000,00", "03/03/2026", "600 ações", "60%",
                       "Pessoa Antiga", "02/01/2024", "Estatuto Alfa.pdf"):
            self.assertIn(trecho, ficha)
        self.assertIn("sem documentos", pg.inner_text(".so-lista"))
        pg.click(".so-lista button:has-text('Beta')")
        pg.wait_for_function("document.querySelector('.so-ficha h2').textContent.startsWith('Beta')")
        pg.click(".so-ficha [data-empresa='alfa']")
        pg.wait_for_function("document.querySelector('.so-ficha h2').textContent.startsWith('Alfa')")
        pg.click(".so-ficha [data-investidor='ext:PESSOA UM']")
        pg.wait_for_function("location.hash.startsWith('#investidores')")
        pg.wait_for_selector("#v-investidores .so-ficha h2")
        inv = pg.inner_text("#v-investidores .so-ficha")
        self.assertIn("Pessoa Um", inv)
        self.assertIn("Pessoa Um → Alfa → Beta", inv)
        self.assertIn("30%", inv)
        self.assertEqual(sum(1 for m, c, _, _ in bot.pedidos if c == "/hub/dados"), 1)   # baixa uma vez só
        self.assertEqual(erros, [])

    def test_7_investidores_busca(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "investidores")
        pg.wait_for_selector("#v-investidores .so-ficha h2")
        self.assertIn("Pessoa Dois", pg.inner_text("#v-investidores .so-ficha h2"))
        pg.fill("#v-investidores .so-busca", "um")
        self.assertEqual([t.split("\n")[0] for t in pg.locator("#v-investidores .so-lista button").all_inner_texts()],
                         ["Pessoa Um"])
        self.assertEqual(erros, [])

    def test_8_procuracoes_contadores_filtros_e_status(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "procuracoes")
        pg.wait_for_selector("#v-procuracoes table")
        self.assertEqual(pg.locator("#abas button").all_inner_texts()[:2], ["Chat", "Procurações"])
        vals = pg.locator(".so-kpis .val").all_inner_texts()
        self.assertEqual(vals, ["1", "1", "0", "1"])
        linhas = pg.locator("#v-procuracoes tbody tr")
        self.assertEqual(linhas.count(), 3)
        primeira = linhas.first.inner_text()
        for trecho in ("VENCIDA", "01/11/2026", "há 12 dias", "Beta", "Pessoa Três", "bancos e INSS",
                       "Ata outorga.pdf, Ata outorga - REGISTRADA.pdf"):
            self.assertIn(trecho, primeira)
        self.assertIn("em 7 dias", linhas.nth(1).inner_text())
        self.assertIn("<b>tudo</b>", linhas.nth(2).inner_text())          # texto do documento não vira HTML
        self.assertIn("lendo documentos: 4 de 6", pg.inner_text("#v-procuracoes").lower())

        pg.click(".so-kpis [data-st='vencida']")
        self.assertEqual(pg.locator("#v-procuracoes tbody tr").count(), 1)
        pg.click("#procTodas")
        pg.select_option("#procEmpresa", "Alfa")
        self.assertEqual(pg.locator("#v-procuracoes tbody tr").count(), 2)
        pg.fill("#procBusca", "receita")
        self.assertEqual(pg.locator("#v-procuracoes tbody tr").count(), 1)
        pg.fill("#procBusca", "nada disso")
        self.assertIn("Nenhuma procuração com esses filtros.", pg.inner_text("#v-procuracoes"))
        self.assertEqual([c for m, c, _, _ in bot.pedidos].count("/hub/procuracoes"), 1)
        self.assertEqual(erros, [])

    def test_9_procuracao_leva_a_empresa_e_aparece_na_ficha(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "procuracoes")
        pg.wait_for_selector("#v-procuracoes table")
        pg.click("#v-procuracoes [data-empresa='beta']")
        pg.wait_for_function("location.hash === '#empresas/beta'")
        pg.wait_for_function("document.querySelector('#v-empresas .so-ficha h2') && "
                             "document.querySelector('#v-empresas .so-ficha h2').textContent.startsWith('Beta')")
        ficha = pg.inner_text("#v-empresas .so-ficha")
        self.assertIn("Procurações", ficha)
        self.assertIn("Pessoa Três", ficha)
        self.assertNotIn("Pessoa Um", ficha)
        self.assertEqual([c for m, c, _, _ in bot.pedidos].count("/hub/procuracoes"), 1)   # reaproveita o que baixou
        self.assertEqual(erros, [])

    def test_10_advogados_lista_ficha_e_busca(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "advogados")
        pg.wait_for_selector("#v-advogados .so-ficha h2")
        self.assertIn("Advogados", pg.locator("#abas button").all_inner_texts())
        ficha = pg.inner_text("#v-advogados .so-ficha")
        for trecho in ("ALFA ADVOGADOS", "00.000.000/0001-00", "Trabalhista", "Reclamação X", "Pessoa Dois",
                       "21 9999-0002", "Listagem Advogados Parceiros.xlsx · atualizada em 13/11/2026 15:00"):
            self.assertIn(trecho, ficha)
        self.assertEqual(pg.get_attribute("#v-advogados a[href^='mailto:']", "href"), "mailto:um@alfa.adv.br")
        self.assertIsNone(pg.evaluate("window.pwned"))
        self.assertIn("<img src=x", ficha)
        self.assertEqual([t for t in pg.locator("#v-advogados thead th").all_inner_texts() if t][-1].upper(), "E-MAIL")   # sem coluna de processo

        pg.click("#v-advogados .so-lista button:has-text('Tributário SP')")               # mesmo nome, outra área
        pg.wait_for_function("location.hash === '#advogados/2'")
        pg.wait_for_function("document.querySelector('#v-advogados .so-ficha').innerText.includes('Pessoa Quatro')")
        pg.click("#v-advogados .so-lista button:has-text('Tributário Rio')")
        pg.wait_for_function("document.querySelector('#v-advogados .so-ficha').innerText.includes('ITBI imóvel A')")
        self.assertEqual([t for t in pg.locator("#v-advogados thead th").all_inner_texts() if t][-1].upper(), "PROCESSO EM CURSO")
        pg.fill("#advBusca", "pessoa um")
        self.assertEqual([t.split("\n")[0] for t in pg.locator("#v-advogados .so-lista button").all_inner_texts()],
                         ["ALFA ADVOGADOS"])
        self.assertEqual(erros, [])

    def test_11_processos_so_com_permissao(self):
        bot = Bot()
        bot.processos_ok = False
        pg, erros = _abrir(self, bot)
        pg.wait_for_timeout(500)
        self.assertFalse(pg.is_visible("#btnProcessos"))
        self.assertEqual(erros, [])

    def test_12_processos_contadores_filtros_ficha_e_escritorio(self):
        bot = Bot()
        pg, erros = _abrir(self, bot)
        pg.wait_for_selector("#btnProcessos", state="visible")
        pg.click("#btnProcessos")
        pg.wait_for_selector("#v-processos .so-ficha h2")
        kpis = [t.replace("\xa0", " ") for t in pg.locator("#v-processos .so-kpis .val").all_inner_texts()]
        self.assertEqual(kpis, ["2", "1", "1", "1", "R$ 150.000,50"])             # total, um por Tipo, prazo 7 dias, valor
        rotulos = [t.upper() for t in pg.locator("#v-processos .so-kpis .label").all_inner_texts()]
        self.assertEqual(rotulos[1:3], ["PERDCOMP", "PROCESSO JUDICIAL"])
        ficha = pg.inner_text("#v-processos .so-ficha").replace("\xa0", " ")
        for trecho in ("Processo Judicial", "Federal", "08/08/2025", "Solicitamos perícia"):
            self.assertIn(trecho, ficha)
        for trecho in ("Reclamação trabalhista", "0000001-00.2025.5.01.0001", "Empresa Alfa", "Réu", "Pessoa X",
                       "1ª Vara do Trabalho RJ", "R$ 150.000,50", "Instrução", "03/11/2026", "Audiência redesignada",
                       "Audiência de instrução", "Processos em andamento.xlsx"):
            self.assertIn(trecho, ficha)
        self.assertIn("em 3 dias", ficha.lower())
        self.assertIn("RISCO PROVÁVEL", ficha.upper())

        pg.click("#v-processos .so-kpis [data-k='tipo:PerdComp']")                    # o contador filtra pelo Tipo
        self.assertEqual(pg.locator("#v-processos .so-lista button").count(), 1)
        self.assertIn("<b>x</b>", pg.inner_text("#v-processos .so-lista"))            # texto da planilha não vira HTML
        self.assertIn("(FILTRO)", pg.inner_text("#v-processos .so-kpis").upper())
        pg.click("#v-processos .so-kpis [data-k='tipo:PerdComp']")
        self.assertEqual(pg.locator("#v-processos .so-lista button").count(), 2)
        pg.select_option("#pcArea", "Trabalhista")
        self.assertEqual(pg.locator("#v-processos .so-lista button").count(), 1)
        pg.select_option("#pcArea", "")
        pg.fill("#pcBusca", "icms")
        self.assertEqual(pg.locator("#v-processos .so-lista button").count(), 1)

        pg.fill("#pcBusca", "")
        pg.click("#v-processos .so-lista button:has-text('Reclamação')")
        pg.wait_for_selector("#pcEscr")
        pg.click("#pcEscr")                                                             # BETA ADVOCACIA → ficha em Advogados
        pg.wait_for_function("location.hash === '#advogados/1'")
        pg.wait_for_function("document.querySelector('#v-advogados .so-ficha') && "
                             "document.querySelector('#v-advogados .so-ficha').innerText.includes('BETA ADVOCACIA')")
        self.assertTrue(any(c == "/hub/processos" for _, c, a, _ in bot.pedidos if a == f"Bearer {TOKEN}"))
        self.assertEqual(erros, [])

    def test_13_envio_de_documento_pela_ficha(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "empresas/gama")                   # empresa sem documento também recebe
        pg.wait_for_selector("#envBtn")
        pdf = b"%PDF-1.4 teste"
        pg.set_input_files("#envArq", files=[{"name": "Ata AGE 11.2026.pdf", "mimeType": "application/pdf", "buffer": pdf}])
        pg.wait_for_function("document.querySelector('#envStatus') && document.querySelector('#envStatus').textContent.startsWith('Enviado')")
        self.assertIn("Enviado: Ata AGE 11.2026.pdf", pg.inner_text("#envStatus"))
        query, corpo = bot.envios[0]
        self.assertEqual((query["empresa"], query["nome"]), (["gama"], ["Ata AGE 11.2026.pdf"]))
        self.assertEqual(corpo, pdf)
        envio = [x for x in bot.pedidos if x[1].startswith("/hub/documentos")][0]
        self.assertEqual((envio[0], envio[2]), ("POST", f"Bearer {TOKEN}"))

        pg.set_input_files("#envArq", files=[{"name": "foto.png", "mimeType": "image/png", "buffer": b"PNG"}])
        pg.wait_for_function("document.querySelector('#envStatus').textContent === 'Só PDF.'")
        self.assertEqual(len(bot.envios), 1)                               # nem chegou ao bot

        bot.envio_status = 409
        pg.set_input_files("#envArq", files=[{"name": "Ata AGE 11.2026.pdf", "mimeType": "application/pdf", "buffer": pdf}])
        pg.wait_for_function("document.querySelector('#envStatus').textContent.startsWith('Já existe')")
        self.assertFalse(pg.is_disabled("#envBtn"))
        self.assertEqual(erros, [])

    def test_14_sem_permissao_de_envio_nao_ha_botao(self):
        bot = Bot()
        bot.envio_ok = False
        pg, erros = _abrir(self, bot, "empresas/alfa")
        pg.wait_for_selector(".so-ficha h2")
        pg.wait_for_timeout(400)
        self.assertEqual(pg.locator("#envBtn").count(), 0)
        self.assertIn("Estatuto Alfa.pdf", pg.inner_text(".so-ficha"))     # a lista continua lá
        self.assertEqual(erros, [])

    def _salvar(self, pg):
        antes = pg.locator(".so-aviso").count()
        pg.click("#fSalvar")
        pg.wait_for_function(f"document.querySelectorAll('.so-aviso').length > {antes}")
        return pg.locator(".so-aviso").last.inner_text()

    def test_15_nova_empresa_e_download_de_documento(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "empresas/alfa")
        pg.wait_for_selector("#novaEmpresa")
        pg.click("#novaEmpresa")
        pg.click("#fSalvar")                                                     # sem nome: não envia
        self.assertIn("Preencha: Nome da empresa", pg.inner_text("#fStatus"))
        self.assertEqual(bot.posts, [])
        pg.fill("#f_nome", "Nova Holding")
        self.assertIn("Empresa criada: Nova Holding", self._salvar(pg))
        self.assertEqual(bot.posts[0][0], "/hub/empresas")
        self.assertEqual(bot.posts[0][2], {"nome": "Nova Holding"})
        self.assertEqual(pg.locator(".so-modal").count(), 0)
        with pg.expect_download() as dl:
            pg.click(".so-ficha [data-doc='Estatuto Alfa.pdf']")
        self.assertEqual(dl.value.suggested_filename, "Estatuto Alfa.pdf")
        self.assertTrue(any(c.startswith("/hub/documentos/arquivo?empresa=alfa&nome=Estatuto") for _, c, _, _ in bot.pedidos))
        self.assertEqual(erros, [])

    def test_16_nova_procuracao_vai_para_a_pasta_da_empresa(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "procuracoes")
        pg.wait_for_selector("#novaProcuracao")
        pg.click("#novaProcuracao")
        pg.wait_for_selector("#f_empresa")
        pg.select_option("#f_empresa", "beta")
        pg.set_input_files("#f_arquivo", files=[{"name": "Procuração 2026.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-p"}])
        self.assertIn("Procuração enviada para Alfa", self._salvar(pg))         # o mock sempre responde "Alfa"
        q, corpo = bot.envios[0]
        self.assertEqual((q["empresa"], q["nome"], corpo), (["beta"], ["Procuração 2026.pdf"], b"%PDF-p"))
        self.assertEqual(erros, [])

    def test_17_advogados_novo_escritorio_novo_advogado_e_anexos(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "advogados")
        pg.wait_for_selector("#novoEscritorio")
        pg.click("#novoEscritorio")
        pg.fill("#f_nome", "GAMA ADVOGADOS")
        pg.fill("#f_area", "Cível")
        pg.fill("#f_adv_nome", "Pessoa G")
        pg.fill("#f_adv_email", "g@gama.adv.br")
        self.assertIn("Escritório incluído: GAMA ADVOGADOS", self._salvar(pg))
        caminho, _, corpo = bot.posts[-1]
        self.assertEqual(caminho, "/hub/advogados")
        self.assertEqual((corpo["nome"], corpo["area"], corpo["advogados"][0]["nome"], corpo["advogados"][0]["email"]),
                         ("GAMA ADVOGADOS", "Cível", "Pessoa G", "g@gama.adv.br"))

        pg.click("#v-advogados .so-lista button:has-text('Tributário SP')")       # 3º escritório (índice 2)
        pg.wait_for_function("document.querySelector('#v-advogados .so-ficha').innerText.includes('Pessoa Quatro')")
        pg.click("#novoAdvogado")
        pg.fill("#f_nome", "Pessoa Cinco")
        pg.wait_for_timeout(50)
        self.assertIn("Advogado incluído: Pessoa Cinco", self._salvar(pg))
        self.assertEqual(bot.posts[-1][0], "/hub/advogados/2/advogados")
        self.assertEqual(bot.posts[-1][2]["nome"], "Pessoa Cinco")

        pg.click("#v-advogados .so-lista button:has-text('ALFA ADVOGADOS')")
        pg.wait_for_selector("#anx-advogados [data-anx]")
        with pg.expect_download() as dl:
            pg.click("#anx-advogados [data-anx='Contrato.pdf']")
        self.assertEqual(dl.value.suggested_filename, "Contrato.pdf")
        pg.set_input_files("#anx-advogados [data-anx-arq]", files=[{"name": "Proposta.docx", "mimeType":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "buffer": b"PK\x03\x04x"}])
        pg.wait_for_function("[...document.querySelectorAll('.so-aviso')].some(e => e.textContent.includes('Anexo enviado: Proposta.docx'))")
        caminho, q, corpo = bot.posts[-1]
        self.assertEqual((caminho, q["tipo"], q["chave"], q["nome"]), ("/hub/anexos", ["advogados"], ["ALFA ADVOGADOS"], ["Proposta.docx"]))
        self.assertEqual(erros, [])

    def test_18_novo_processo_e_anexo_pelo_id(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "processos")
        pg.wait_for_selector("#novoProcesso")
        pg.click("#novoProcesso")
        pg.fill("#f_objeto", "Execução fiscal X")
        pg.select_option("#f_risco", "Remoto")
        pg.fill("#f_valor_causa", "1234.5")
        pg.fill("#f_data_proximo_prazo", "2026-12-01")
        self.assertIn("Processo P-0099 incluído", self._salvar(pg))
        corpo = bot.posts[-1][2]
        self.assertEqual((corpo["objeto"], corpo["risco"], corpo["valor_causa"], corpo["data_proximo_prazo"]),
                         ("Execução fiscal X", "Remoto", 1234.5, "2026-12-01"))
        pg.wait_for_selector("#anx-processos")
        self.assertEqual(pg.get_attribute("#anx-processos", "data-chave"), "P-0001")
        self.assertIn("Nenhum anexo", pg.inner_text("#anx-processos"))
        self.assertEqual(erros, [])

    def test_19_investidor_tem_anexos_so_para_quem_envia(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "investidores")
        pg.wait_for_selector("#anx-investidores")
        self.assertEqual(pg.get_attribute("#anx-investidores", "data-chave"), "Pessoa Dois")
        bot2 = Bot()
        bot2.envio_ok = False
        pg2, erros2 = _abrir(self, bot2, "investidores")
        pg2.wait_for_selector("#v-investidores .so-ficha h2")
        pg2.wait_for_timeout(400)
        self.assertEqual(pg2.locator("#anx-investidores").count(), 0)
        self.assertEqual(erros + erros2, [])

    def test_20_sem_permissao_de_envio_nada_de_criar(self):
        bot = Bot()
        bot.envio_ok = False
        for secao, botao in (("empresas/alfa", "#novaEmpresa"), ("procuracoes", "#novaProcuracao"),
                             ("advogados", "#novoEscritorio"), ("processos", "#novoProcesso")):
            pg, erros = _abrir(self, bot, secao)
            pg.wait_for_timeout(700)
            self.assertEqual(pg.locator(botao).count(), 0, botao)
            self.assertEqual(pg.locator("[data-anx-enviar]").count(), 0, secao)
            self.assertEqual(erros, [])
        self.assertEqual(bot.posts, [])

    def test_21_editar_e_excluir_empresa(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "empresas/alfa")
        pg.wait_for_selector("#editEmpresa")
        self.assertEqual(pg.locator("#exclEmpresa").count(), 0)                  # tem documentos
        pg.click("#editEmpresa")
        self.assertEqual(pg.input_value("#f_pasta"), "Alfa")
        self.assertEqual(pg.input_value("#f_cnpj"), "00.000.000/0001-00")
        pg.fill("#f_cnpj", "11.111.111/0001-11")
        self.assertIn("Empresa salva", self._salvar(pg))
        self.assertEqual(bot.posts[-1][0], "/hub/empresas/alfa/editar")
        self.assertEqual(bot.posts[-1][2], {"cnpj": "11.111.111/0001-11"})      # só o que mudou
        pg.evaluate("location.hash = '#empresas/gama'")
        pg.wait_for_selector("#exclEmpresa")
        pg.once("dialog", lambda d: d.accept())
        pg.click("#exclEmpresa")
        pg.wait_for_function("[...document.querySelectorAll('.so-aviso')].some(e => e.textContent.includes('Empresa excluída'))")
        self.assertEqual(bot.posts[-1][0], "/hub/empresas/gama/excluir")
        self.assertEqual(erros, [])

    def test_22_excluir_e_restaurar_procuracao_vencida(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "procuracoes")
        pg.wait_for_selector("#v-procuracoes table")
        self.assertEqual(pg.locator("#v-procuracoes [data-excl]").count(), 1)     # só a vencida
        self.assertIn("Excluir vencidas (1)", pg.inner_text("#procExclVenc"))
        pg.once("dialog", lambda d: d.accept())
        pg.click("#v-procuracoes [data-excl]")
        pg.wait_for_function("document.querySelectorAll('#v-procuracoes tbody tr').length === 2")
        self.assertEqual(bot.posts[-1][0], "/hub/procuracoes/excluir")
        self.assertEqual(bot.posts[-1][2], {"chaves": ["beta|PESSOA TRES|2026-11-01|2025-01-01"]})
        self.assertEqual(pg.locator("#procExclVenc").count(), 0)
        pg.click("#procVerExcl")
        pg.wait_for_selector("#v-procuracoes [data-rest]")
        self.assertIn("Pessoa Velha", pg.inner_text("#v-procuracoes"))
        pg.click("#v-procuracoes [data-rest]")
        pg.wait_for_function("[...document.querySelectorAll('.so-aviso')].some(e => e.textContent.includes('restaurada'))")
        self.assertEqual(bot.posts[-1], ("/hub/procuracoes/restaurar", {}, {"chaves": ["x|VELHA|2020-01-01|"]}))
        self.assertEqual(erros, [])

    def test_23_editar_e_excluir_escritorio_e_advogado(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "advogados")
        pg.wait_for_selector("#editEscr")
        pg.click("#editEscr")
        self.assertEqual(pg.input_value("#f_area"), "Trabalhista")
        pg.fill("#f_area", "Trabalhista e Cível")
        self._salvar(pg)
        self.assertEqual(bot.posts[-1][0], "/hub/advogados/0/editar")
        self.assertEqual(bot.posts[-1][2], {"area": "Trabalhista e Cível", "nome_atual": "ALFA ADVOGADOS"})
        pg.click("#v-advogados [data-adv-ed='1']")
        self.assertEqual(pg.input_value("#f_email"), "dois@alfa.adv.br")
        pg.fill("#f_email", "novo@alfa.adv.br")
        self._salvar(pg)
        self.assertEqual(bot.posts[-1][0], "/hub/advogados/0/advogados/1/editar")
        self.assertEqual(bot.posts[-1][2], {"email": "novo@alfa.adv.br", "nome_atual": "Pessoa Dois", "escritorio": "ALFA ADVOGADOS"})
        pg.once("dialog", lambda d: d.accept())
        pg.click("#v-advogados [data-adv-ex='0']")
        pg.wait_for_function("[...document.querySelectorAll('.so-aviso')].some(e => e.textContent.includes('Advogado excluído'))")
        self.assertEqual(bot.posts[-1][2], {"nome_atual": "Pessoa Um", "escritorio": "ALFA ADVOGADOS"})
        pg.once("dialog", lambda d: d.dismiss())                                  # cancelou: nada vai pro bot
        n = len(bot.posts)
        pg.click("#exclEscr")
        pg.wait_for_timeout(300)
        self.assertEqual(len(bot.posts), n)
        self.assertEqual(erros, [])

    def test_24_importar_advogados_com_previa(self):
        bot = Bot()
        bot.previa["advogados"] = {"lidos": 5, "escritorios": [{"nome": "NOVO ESCR", "area": "Cível", "advogados": [{"nome": "X"}]}],
                                   "advogados": [{"indice": 0, "escritorio": "ALFA ADVOGADOS", "nome": "Pessoa Nova"}]}
        pg, erros = _abrir(self, bot, "advogados")
        pg.wait_for_selector("#importarAdv")
        pg.click("#importarAdv")
        pg.set_input_files("#importArq", files=[{"name": "lista.xlsx", "mimeType":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "buffer": b"PK\x03\x04planilha"}])
        pg.wait_for_selector("#pOk")
        previa = pg.inner_text(".so-modal")
        self.assertIn("NOVO ESCR", previa)
        self.assertIn("Pessoa Nova", previa)
        self.assertIn("5 na planilha, 2 novos", previa)
        self.assertEqual(bot.posts[-1][1]["confirmar"], ["0"])
        pg.click("#pOk")
        pg.wait_for_function("[...document.querySelectorAll('.so-aviso')].some(e => e.textContent.includes('2 itens importados'))")
        self.assertEqual((bot.posts[-1][0], bot.posts[-1][1]["confirmar"], bot.posts[-1][2]),
                         ("/hub/advogados/importar", ["1"], b"PK\x03\x04planilha"))
        self.assertEqual(erros, [])

    def test_25_editar_processo_e_importacao_sem_novidade(self):
        bot = Bot()
        bot.previa["processos"] = {"lidos": 3, "processos": []}
        pg, erros = _abrir(self, bot, "processos")
        pg.wait_for_selector("#editProc")
        pg.click("#editProc")
        self.assertEqual(pg.input_value("#f_valor_causa"), "150000.5")
        pg.select_option("#f_risco", "Remoto")
        self._salvar(pg)
        self.assertEqual(bot.posts[-1][0], "/hub/processos/P-0001/editar")
        self.assertEqual(bot.posts[-1][2], {"risco": "Remoto"})
        pg.click("#importarProc")
        pg.set_input_files("#importArq", files=[{"name": "p.xlsx", "mimeType": "application/octet-stream", "buffer": b"PK\x03\x04x"}])
        pg.wait_for_selector(".so-modal #pCancelar")
        self.assertIn("3 na planilha, 0 novos", pg.inner_text(".so-modal"))
        self.assertEqual(pg.locator("#pOk").count(), 0)
        self.assertEqual(pg.inner_text("#pCancelar"), "Fechar")
        self.assertEqual(erros, [])

    def test_26_campos_pedidos_situacao_e_andamento_cnj(self):
        bot = Bot()
        pg, erros = _abrir(self, bot, "processos")
        pg.wait_for_selector("#pcCnj")
        ficha = pg.inner_text("#v-processos .so-ficha").replace("\xa0", " ")
        for trecho in ("00.000.000/0001-00", "Empresa Alfa", "Trabalhista", "0000001-00.2025.5.01.0001", "Pessoa X",
                       "BETA ADVOCACIA", "TRT1", "Ação Trabalhista", "12/11/2026 10:30", "Audiência designada", "Citação"):
            self.assertIn(trecho, ficha)
        self.assertIn("JURÍDICO RESPONSÁVEL", ficha.upper())
        self.assertIn("ATIVO", pg.inner_text("#v-processos .so-ficha h2").upper())
        pg.select_option("#pcSituacao", "Inativo")
        self.assertEqual(pg.locator("#v-processos .so-lista button").count(), 1)
        pg.click("#v-processos .so-lista button")
        pg.wait_for_function("document.querySelector('#v-processos .so-ficha h2').textContent.toUpperCase().includes('INATIVO')")
        self.assertEqual(pg.locator("#pcCnj").count(), 0)                         # sem número CNJ, sem cartão
        pg.click("#novoProcesso")
        self.assertEqual([pg.inner_text(f"label:has(#f_{c}) span") for c in ("empresa", "documento", "area", "numero")],
                         ["ESTRUTURA (EMPRESA OU PESSOA FÍSICA)", "CNPJ OU CPF", "CLASSE", "NÚMERO DO PROCESSO"])
        pg.click("#fSalvar")
        pg.wait_for_function("document.querySelector('#fStatus').textContent.includes('Informe o número')")
        pg.fill("#f_numero", "PA 123/2024")
        pg.select_option("#f_situacao", "Ativo")
        self._salvar(pg)
        self.assertEqual((bot.posts[-1][2]["numero"], bot.posts[-1][2]["situacao"]), ("PA 123/2024", "Ativo"))
        self.assertEqual(erros, [])

    def test_28_ficha_mostra_todo_campo_e_edicao_aparece_na_hora(self):
        """Mauricio salvou Observações e a data, voltou e viu o valor antigo; e a ficha
        escondia os campos vazios, só o Editar mostrava."""
        bot = Bot()
        bot.procs = json.loads(json.dumps(PROCS))
        bot.procs["campos"] = ["empresa", "documento", "tipo", "area", "numero", "data_ultima_movimentacao",
                               "observacoes", "escritorio", "fase", "situacao"]
        bot.espelhado = True
        pg, erros = _abrir(self, bot, "processos")
        pg.wait_for_selector("#v-processos .so-lista button")
        pg.locator("#v-processos .so-lista button").nth(1).click()
        pg.wait_for_function("document.querySelector('#v-processos .so-ficha h2').textContent.toUpperCase().includes('INATIVO')")
        ficha = pg.inner_text("#v-processos .so-ficha")
        for rotulo in ("CNPJ OU CPF", "FASE", "DATA DA ÚLTIMA POSIÇÃO", "OBSERVAÇÕES"):    # vazios, mas a planilha tem
            self.assertIn(rotulo, ficha.upper())
        self.assertGreaterEqual(ficha.count("—"), 4)
        self.assertNotIn("TRIBUNAL", ficha.upper())                                      # a planilha não tem a coluna
        pg.click("#editProc")
        pg.fill("#f_observacoes", "Contestação protocolada")
        pg.fill("#f_data_ultima_movimentacao", "2026-11-25")
        p2 = bot.procs["processos"][1]
        p2["observacoes"], p2["data_ultima_movimentacao"] = "Contestação protocolada", "2026-11-25"
        self._salvar(pg)
        self.assertEqual(bot.posts[-1][2], {"observacoes": "Contestação protocolada", "data_ultima_movimentacao": "2026-11-25"})
        pg.wait_for_function("document.querySelector('#v-processos .so-ficha').textContent.includes('Contestação protocolada')")
        self.assertIn("25/11/2026", pg.inner_text("#v-processos .so-ficha"))
        self.assertNotIn("alguns minutos", pg.inner_text(".so-aviso"))
        self.assertEqual(sum(1 for m, c, _, _ in bot.pedidos if m == "GET" and c == "/hub/processos"), 2)
        pg.click("#editProc")                                                             # o Editar já vem com o salvo
        self.assertEqual(pg.input_value("#f_observacoes"), "Contestação protocolada")
        self.assertEqual(erros, [])

    def test_27_busca_por_especialidade(self):
        bot = Bot()
        bot_adv = json.loads(json.dumps(ADV))
        pg, erros = _abrir(self, bot, "advogados")
        pg.wait_for_selector("#advBusca")
        self.assertEqual(pg.locator("#advEsp").count(), 0)                                 # sem seletor separado
        lista = lambda: [t.split("\n")[0] for t in pg.locator("#v-advogados .so-lista button").all_inner_texts()]
        pg.fill("#advBusca", "tributario")                                                  # sem acento acha "Tributário"
        self.assertEqual(lista(), ["BETA ADVOCACIA", "BETA ADVOCACIA"])
        pg.fill("#advBusca", "trabalh")
        self.assertEqual(lista(), ["ALFA ADVOGADOS"])
        pg.fill("#advBusca", "nada disso")
        self.assertIn("Nenhum escritório encontrado", pg.inner_text("#v-advogados .so-lista"))
        self.assertEqual(erros, [])

if __name__ == "__main__":
    unittest.main(verbosity=2)
