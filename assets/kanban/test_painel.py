"""Testa o Kanban com o supabase-js REAL e a rede interceptada.

Mesma abordagem do Saldo Bancário e do Controle de Pagamentos: a página abre por
file://, e um PostgREST de mentira (em memória, aqui embaixo) responde às consultas das
tabelas kanban_*. Assim o teste também confere se as chamadas que a tela faz produzem as
requisições certas — o que é gravado, em que tabela, com que campos.

Roda sem credencial, sem sessão e sem tocar no Supabase de verdade (o tempo real não
liga em file://, ver kb_fonte.assinar).

Uso: python assets/kanban/test_painel.py   (da raiz do repo do hub)
"""

import copy
import json
import pathlib
import unittest
import urllib.parse

AQUI = pathlib.Path(__file__).resolve().parent

EU = "fulano@luxor.com.br"
L_TODO, L_WIP, L_DONE, L_VELHA = "l-todo", "l-wip", "l-done", "l-velha"
E_ALINE, E_ARTHUR = "e-aline", "e-arthur"
M_EU, M_ALINE, M_GRUPO = "m-eu", "m-aline", "m-grupo"

BASE = {
    "kanban_listas": [
        {"id": L_TODO, "nome": "To Do", "pos": 100, "arquivada": False},
        {"id": L_WIP, "nome": "Work in Progress", "pos": 200, "arquivada": False},
        {"id": L_DONE, "nome": "Done", "pos": 300, "arquivada": False},
        {"id": L_VELHA, "nome": "Done antigo", "pos": 400, "arquivada": True},
    ],
    "kanban_etiquetas": [
        {"id": E_ALINE, "nome": "Aline", "cor": "pink"},
        {"id": E_ARTHUR, "nome": "Arthur", "cor": "blue"},
    ],
    "kanban_membros": [
        {"id": M_EU, "nome": "Fulano de Tal", "usuario": "fulano123", "email": EU},
        {"id": M_ALINE, "nome": "Aline", "usuario": "aline99", "email": "alguem@luxor.com.br"},
        {"id": M_GRUPO, "nome": "Grupo Luxor", "usuario": "grupoluxor2", "email": None},
    ],
    "kanban_cards": [
        {"id": "c-fech", "lista_id": L_TODO, "nome": "Fechamento Resultado - Out/2026",
         "descricao": "**Prazo** dia 5\n\n- conferir DRE\n- enviar", "pos": 1000, "arquivado": False,
         "arquivado_em": None, "prazo": None, "prazo_concluido": False, "modelo": False,
         "criado_por": "Aline", "criado_em": "2026-11-03T11:00:00Z", "atualizado_em": "2026-11-05T10:00:00Z",
         "trello_url": "https://trello.com/c/abcdefgh"},
        {"id": "c-xss", "lista_id": L_TODO, "nome": "<img src=x onerror=window.__xss=1> card estranho",
         "descricao": "[clique](javascript:window.__xss=2)", "pos": 2000, "arquivado": False,
         "arquivado_em": None, "prazo": None, "prazo_concluido": False, "modelo": False,
         "criado_por": "Fulano de Tal", "criado_em": "2026-11-04T11:00:00Z", "atualizado_em": "2026-11-04T11:00:00Z",
         "trello_url": None},
        {"id": "c-dre", "lista_id": L_WIP, "nome": "DRE Casa - Out/26", "descricao": "", "pos": 500,
         "arquivado": False, "arquivado_em": None, "prazo": "2020-01-01T12:00:00Z", "prazo_concluido": False,
         "modelo": True, "criado_por": "Aline", "criado_em": "2026-11-03T11:00:00Z",
         "atualizado_em": "2026-11-03T11:00:00Z", "trello_url": None},
        {"id": "c-arq", "lista_id": L_DONE, "nome": "Arquivado velho", "descricao": "", "pos": 10,
         "arquivado": True, "arquivado_em": "2025-01-10T10:00:00Z", "prazo": None, "prazo_concluido": False,
         "modelo": False, "criado_por": "Aline", "criado_em": "2024-12-01T11:00:00Z",
         "atualizado_em": "2025-01-10T10:00:00Z", "trello_url": None},
        {"id": "c-lvelha", "lista_id": L_VELHA, "nome": "Card de lista arquivada", "descricao": "", "pos": 10,
         "arquivado": False, "arquivado_em": None, "prazo": None, "prazo_concluido": False, "modelo": False,
         "criado_por": "Aline", "criado_em": "2024-12-01T11:00:00Z",
         "atualizado_em": "2024-12-01T11:00:00Z", "trello_url": None},
    ],
    "kanban_card_etiquetas": [{"card_id": "c-fech", "etiqueta_id": E_ALINE},
                              {"card_id": "c-dre", "etiqueta_id": E_ARTHUR}],
    "kanban_card_membros": [{"card_id": "c-fech", "membro_id": M_EU},
                            {"card_id": "c-dre", "membro_id": M_ALINE}],
    "kanban_checklists": [{"id": "k1", "card_id": "c-fech", "nome": "Checklist", "pos": 1}],
    "kanban_checkitens": [
        {"id": "i1", "checklist_id": "k1", "nome": "Conferir DRE", "pos": 1, "concluido": True,
         "membro_id": None, "prazo": None},
        {"id": "i2", "checklist_id": "k1", "nome": "Enviar ao board", "pos": 2, "concluido": False,
         "membro_id": M_ALINE, "prazo": None},
    ],
    "kanban_comentarios": [
        {"id": "cm1", "card_id": "c-fech", "autor_nome": "Aline", "autor_email": "alguem@luxor.com.br",
         "texto": "Segue ![image.png](anexo:trello/abc/image.png) @fulano123 <script>window.__xss=3</script>",
         "criado_em": "2026-11-04T09:00:00Z", "editado_em": None},
        {"id": "cm2", "card_id": "c-fech", "autor_nome": "Fulano de Tal", "autor_email": EU,
         "texto": "meu comentário", "criado_em": "2026-11-04T10:00:00Z", "editado_em": None},
    ],
    "kanban_anexos": [
        {"id": "a1", "card_id": "c-fech", "nome": "relatorio.pdf", "caminho": "trello/x/relatorio.pdf",
         "url": None, "mime": "application/pdf", "bytes": 123456, "autor_nome": "Aline",
         "autor_email": "alguem@luxor.com.br", "criado_em": "2026-11-04T09:00:00Z", "pos": 1},
    ],
    "kanban_atividade": [
        {"id": "at1", "card_id": "c-fech", "tipo": "moveu", "dados": {"de": "Backlog", "para": "To Do"},
         "autor_nome": "Aline", "autor_email": "alguem@luxor.com.br", "criado_em": "2026-11-03T12:00:00Z"},
    ],
}

PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


def _filtros(query):
    """`campo=eq.valor` da query do PostgREST -> {campo: valor}."""
    out = {}
    for k, v in urllib.parse.parse_qsl(query):
        if v.startswith("eq."):
            out[k] = v[3:]
        elif v.startswith("is."):
            out[k] = {"true": True, "false": False, "null": None}[v[3:]]
    return out


class Fake:
    """PostgREST em memória, só com o que a tela usa."""

    def __init__(self):
        self.db = copy.deepcopy(BASE)
        self.escritas = []        # (método, tabela, filtros, corpo)
        self.seq = 0

    def _casa(self, linha, f):
        return all(str(linha.get(k)).lower() == str(v).lower() if not isinstance(v, bool) and v is not None
                   else linha.get(k) is v for k, v in f.items() if k in linha)

    def card_resumo(self, c):
        cls = [k for k in self.db["kanban_checklists"] if k["card_id"] == c["id"]]
        return {**c,
                "kanban_card_etiquetas": [{"etiqueta_id": x["etiqueta_id"]} for x in self.db["kanban_card_etiquetas"] if x["card_id"] == c["id"]],
                "kanban_card_membros": [{"membro_id": x["membro_id"]} for x in self.db["kanban_card_membros"] if x["card_id"] == c["id"]],
                "kanban_checklists": [{"kanban_checkitens": [{"concluido": i["concluido"]} for i in self.db["kanban_checkitens"] if i["checklist_id"] == k["id"]]} for k in cls],
                "kanban_comentarios": [{"count": sum(1 for x in self.db["kanban_comentarios"] if x["card_id"] == c["id"])}],
                "kanban_anexos": [{"count": sum(1 for x in self.db["kanban_anexos"] if x["card_id"] == c["id"])}]}

    def get(self, tabela, query):
        f = _filtros(query)
        q = dict(urllib.parse.parse_qsl(query))
        if tabela == "kanban_cards":
            linhas = self.db["kanban_cards"]
            if "or" in q:     # arquivados: arquivado ou de lista arquivada
                velhas = {l["id"] for l in self.db["kanban_listas"] if l["arquivada"]}
                linhas = [c for c in linhas if c["arquivado"] or c["lista_id"] in velhas]
            else:
                linhas = [c for c in linhas if self._casa(c, {k: v for k, v in f.items() if k in ("id", "arquivado")})]
            return [self.card_resumo(c) for c in linhas]
        if tabela == "kanban_checklists":
            return [{**k, "kanban_checkitens": [i for i in self.db["kanban_checkitens"] if i["checklist_id"] == k["id"]]}
                    for k in self.db["kanban_checklists"] if self._casa(k, f)]
        if tabela == "kanban_atividade":
            linhas = [a for a in self.db["kanban_atividade"] if self._casa(a, f)]
            if "card_id" not in f:
                nomes = {c["id"]: c["nome"] for c in self.db["kanban_cards"]}
                linhas = [{**a, "kanban_cards": {"nome": nomes.get(a["card_id"])} if a["card_id"] else None} for a in linhas]
            return sorted(linhas, key=lambda a: a["criado_em"], reverse=True)
        return [x for x in self.db.get(tabela, []) if self._casa(x, f)]

    def post(self, tabela, corpo):
        linhas = corpo if isinstance(corpo, list) else [corpo]
        out = []
        for l in linhas:
            l = dict(l)
            if tabela in ("kanban_cards", "kanban_comentarios", "kanban_checklists", "kanban_checkitens",
                          "kanban_anexos", "kanban_listas", "kanban_etiquetas"):
                self.seq += 1
                l.setdefault("id", f"novo-{self.seq}")
            if tabela == "kanban_cards":
                l = {"descricao": "", "arquivado": False, "arquivado_em": None, "prazo": None,
                     "prazo_concluido": False, "modelo": False, "criado_por": "Fulano de Tal",
                     "criado_em": "2026-11-12T12:00:00Z", "atualizado_em": "2026-11-12T12:00:00Z",
                     "trello_url": None, **l}
            if tabela == "kanban_comentarios":   # o gatilho do banco carimba o autor
                l.update({"autor_nome": "Fulano de Tal", "autor_email": EU,
                          "criado_em": "2026-11-12T12:00:00Z", "editado_em": None})
            if tabela == "kanban_checkitens":
                l.setdefault("concluido", False); l.setdefault("membro_id", None); l.setdefault("prazo", None)
            self.db.setdefault(tabela, []).append(l)
            out.append(l)
        return out

    def patch(self, tabela, query, corpo):
        f = _filtros(query)
        alvo = [x for x in self.db.get(tabela, []) if self._casa(x, f)]
        for x in alvo:
            x.update(corpo)
        return alvo

    def delete(self, tabela, query):
        f = _filtros(query)
        alvo = [x for x in self.db.get(tabela, []) if self._casa(x, f)]
        self.db[tabela] = [x for x in self.db.get(tabela, []) if x not in alvo]
        return alvo


def _pagina(cls):
    from playwright.sync_api import sync_playwright

    if not hasattr(cls, "_pw"):
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
    cls.fake = Fake()
    cls.erros = []
    pg = cls._b.new_page(viewport={"width": 1500, "height": 950})
    pg.on("pageerror", lambda e: cls.erros.append(str(e)))

    def rota(route, request):
        url, metodo = request.url, request.method
        partes = urllib.parse.urlsplit(url)
        caminho, query = partes.path, partes.query
        objeto = "vnd.pgrst.object" in (request.headers.get("accept") or "")

        def responder(dados, status=200):
            if objeto and isinstance(dados, list):
                if not dados:
                    return route.fulfill(status=406, content_type="application/json",
                                         body=json.dumps({"message": "0 rows"}))
                dados = dados[0]
            return route.fulfill(status=status, content_type="application/json", body=json.dumps(dados))

        if caminho.startswith("/storage/v1/object/sign/"):
            alvo = caminho[len("/storage/v1/object/sign/"):]
            return responder({"signedURL": f"/object/sign/{alvo}?token=tk"})
        if caminho.startswith("/storage/v1/object/"):
            if metodo == "GET":
                return route.fulfill(status=200, content_type="image/png", body=PNG_1PX)
            cls.fake.escritas.append((metodo, "storage", caminho, request.post_data))
            return responder({"Key": caminho})
        if caminho == "/rest/v1/rpc/kanban_entrar":
            return responder(M_EU)
        if caminho == "/rest/v1/rpc/kanban_copiar_card":
            corpo = json.loads(request.post_data)
            cls.fake.escritas.append(("RPC", "kanban_copiar_card", {}, corpo))
            novo = cls.fake.post("kanban_cards", {"lista_id": corpo["p_lista"], "nome": corpo["p_nome"],
                                                  "pos": corpo["p_pos"]})[0]
            return responder(novo["id"])
        if caminho.startswith("/rest/v1/"):
            tabela = caminho[len("/rest/v1/"):]
            if metodo == "GET":
                return responder(cls.fake.get(tabela, query))
            corpo = json.loads(request.post_data) if request.post_data else None
            cls.fake.escritas.append((metodo, tabela, _filtros(query), corpo))
            if metodo == "POST":
                return responder(cls.fake.post(tabela, corpo), 201)
            if metodo == "PATCH":
                return responder(cls.fake.patch(tabela, query, corpo))
            if metodo == "DELETE":
                return responder(cls.fake.delete(tabela, query))
        return route.fulfill(status=404, body="")

    pg.route("**/*.supabase.co/**", rota)
    pg.add_init_script(f"window.HUB = {{email:'{EU}'}}; window.__xss = 0;")
    pg.goto((AQUI / "index.html").as_uri())
    pg.wait_for_selector(".kcol", timeout=8000)
    pg.wait_for_timeout(300)
    return pg


def _ultima(cls, metodo, tabela):
    for m, t, f, c in reversed(cls.fake.escritas):
        if m == metodo and t == tabela:
            return f, c
    return None, None


class TestKanban(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import playwright  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        cls.pg = _pagina(cls)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_b"):
            cls._b.close()
            cls._pw.stop()

    def _fechar(self):
        self.pg.keyboard.press("Escape")
        self.pg.wait_for_timeout(150)
        if self.pg.locator("#ovl").count():
            self.pg.click("#btFechar")
            self.pg.wait_for_timeout(150)

    # ---------------- board ----------------

    def test_01_so_listas_abertas_na_ordem(self):
        nomes = self.pg.locator(".kcol-head h2").all_inner_texts()
        self.assertEqual(nomes, ["To Do", "Work in Progress", "Done"],
                         "lista arquivada não aparece no board, como no Trello")

    def test_02_cards_na_ordem_sem_arquivado(self):
        todo = self.pg.locator(f'.kcol-cards[data-lista="{L_TODO}"] .kcard .ttl').all_inner_texts()
        self.assertEqual(len(todo), 2)
        self.assertTrue(todo[0].startswith("Fechamento Resultado"))
        self.assertNotIn("Arquivado velho", self.pg.inner_text("#board"))
        self.assertNotIn("Card de lista arquivada", self.pg.inner_text("#board"))

    def test_03_resumo_do_card(self):
        face = self.pg.locator('.kcard[data-id="c-fech"]')
        txt = face.inner_text()
        self.assertIn("Aline", txt, "etiqueta com o nome")
        self.assertIn("1/2", txt, "itens do checklist feitos/total")
        self.assertIn("2", txt, "comentários")
        self.assertEqual(face.locator(".av").count(), 1, "um membro")
        dre = self.pg.locator('.kcard[data-id="c-dre"]')
        self.assertIn("Modelo", dre.inner_text())
        self.assertEqual(dre.locator(".prazo.vencido").count(), 1, "prazo vencido em destaque")

    def test_04_nome_com_html_nao_executa(self):
        self.assertEqual(self.pg.evaluate("window.__xss"), 0)
        self.assertIn("<img src=x", self.pg.locator('.kcard[data-id="c-xss"] .ttl').inner_text(),
                      "o nome aparece como texto, não como tag")

    def test_05_filtro_de_texto_sem_acento(self):
        pg = self.pg
        pg.fill("#fTexto", "fechamento resultado")
        pg.wait_for_timeout(150)
        self.assertEqual(pg.locator(".kcard").count(), 1)
        pg.fill("#fTexto", "")
        pg.wait_for_timeout(150)
        self.assertEqual(pg.locator(".kcard").count(), 3)

    def test_06_meus_cards(self):
        pg = self.pg
        pg.click("#fMeus")
        pg.wait_for_timeout(150)
        self.assertEqual([e.get_attribute("data-id") for e in pg.locator(".kcard").all()], ["c-fech"])
        pg.click("#fLimpar")
        pg.wait_for_timeout(150)
        self.assertEqual(pg.locator(".kcard").count(), 3)

    # ---------------- card aberto ----------------

    def test_10_abre_o_card_com_tudo(self):
        pg = self.pg
        pg.click('.kcard[data-id="c-fech"]')
        pg.wait_for_selector("#ovl")
        txt = pg.inner_text("#ovl")
        self.assertIn("Prazo", pg.inner_html("#mdDesc"))
        self.assertIn("<strong>Prazo</strong>", pg.inner_html("#mdDesc"), "markdown da descrição")
        self.assertIn("Conferir DRE", txt)
        self.assertIn("relatorio.pdf", txt)
        self.assertIn("meu comentário", txt)
        self.assertIn("@Fulano de Tal", txt, "menção do Trello vira o nome")
        self.assertEqual(pg.evaluate("window.__xss"), 0, "<script> no comentário não roda")
        # só o próprio comentário tem Editar/Excluir
        self.assertEqual(pg.locator('[data-coment="cm2"] [data-a="editar-coment"]').count(), 1)
        self.assertEqual(pg.locator('[data-coment="cm1"] [data-a="editar-coment"]').count(), 0)

    def test_11_imagem_colada_vem_assinada(self):
        pg = self.pg
        pg.wait_for_timeout(400)
        src = pg.locator('[data-coment="cm1"] img').get_attribute("src")
        self.assertIn("/storage/v1/object/sign/kanban/trello/abc/image.png", src)
        self.assertIn("token=", src)

    def test_12_marcar_item(self):
        pg = self.pg
        pg.click('[data-item="i2"] input[type=checkbox]')
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_checkitens")
        self.assertEqual(f, {"id": "i2"})
        self.assertEqual(c, {"concluido": True})

    def test_13_comentar_nao_manda_autor(self):
        pg = self.pg
        pg.fill("#novoComent", "pronto, enviado")
        pg.click('[data-a="comentar"]')
        pg.wait_for_timeout(500)
        _f, c = _ultima(self, "POST", "kanban_comentarios")
        self.assertEqual(c, {"card_id": "c-fech", "texto": "pronto, enviado"},
                         "autor sai do login, num gatilho do banco — a tela não manda")
        self.assertIn("pronto, enviado", pg.inner_text("#ovl"))

    def test_14_mover_pelo_seletor_vai_para_o_fim(self):
        pg = self.pg
        pg.select_option("#mLista", L_WIP)
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual(f, {"id": "c-fech"})
        self.assertEqual(c["lista_id"], L_WIP)
        self.assertGreater(c["pos"], 500, "entra depois do último card da lista de destino")

    def test_15_copiar_usa_a_funcao_do_banco(self):
        pg = self.pg
        pg.click('.dlg-side [data-a="copiar"]')
        pg.fill("#inCpNome", "Fechamento Resultado - Nov/2026")
        pg.uncheck("#cpMbr")
        pg.select_option("#inCpLista", L_TODO)
        pg.click('[data-c="ok"]')
        pg.wait_for_timeout(700)
        _f, c = _ultima(self, "RPC", "kanban_copiar_card")
        self.assertEqual(c["p_origem"], "c-fech")
        self.assertEqual(c["p_nome"], "Fechamento Resultado - Nov/2026")
        self.assertEqual((c["p_checklists"], c["p_etiquetas"], c["p_membros"]), (True, True, False))
        self.assertEqual(c["p_lista"], L_TODO)
        self._fechar()

    def test_16_arrastar_grava_so_o_card_entre_os_vizinhos(self):
        pg = self.pg
        self._fechar()
        antes = pg.evaluate("() => KB_TELA.estado().cards.filter(c => c.lista_id === 'l-todo').map(c => [c.id, c.pos])")
        ordem = sorted(antes, key=lambda x: x[1])
        # move o último da To Do para o topo
        ultimo, primeiro = ordem[-1][0], ordem[0]
        pg.evaluate(f"() => KB_TELA.moverCard('{ultimo}', 'l-todo', null, '{primeiro[0]}')")
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual(f, {"id": ultimo})
        self.assertEqual(c, {"pos": primeiro[1] / 2}, "metade do primeiro, e só a posição")

    def test_20_arquivados(self):
        pg = self.pg
        pg.click("#btArquivados")
        pg.wait_for_timeout(500)
        txt = pg.inner_text(".gaveta")
        self.assertIn("Arquivado velho", txt)
        self.assertIn("Card de lista arquivada", txt, "card de lista arquivada também é arquivo")
        pg.click('.gaveta [data-aba="listas"]')
        pg.wait_for_timeout(200)
        self.assertIn("Done antigo", pg.inner_text(".gaveta"))
        pg.click("#btFecharGav")

    def test_21_atividade_do_board(self):
        pg = self.pg
        pg.click("#btAtividade")
        pg.wait_for_timeout(500)
        self.assertIn("moveu", pg.inner_text(".gaveta"))
        pg.click("#btFecharGav")

    def test_99_sem_erro_de_console(self):
        self.assertEqual(self.erros, [], f"erros no navegador: {self.erros}")


class TestRegras(unittest.TestCase):
    """KB_DADOS sem tela: posição, markdown e frases do histórico."""

    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
        cls.pg = cls._b.new_page()
        cls.pg.goto((AQUI / "kb_dados.js").as_uri())
        cls.pg.add_script_tag(path=str(AQUI / "kb_dados.js"))

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def md(self, t):
        return self.pg.evaluate("t => KB_DADOS.markdown(t, {usuarios:{fulano123:'Fulano'}})", t)

    def test_posicao(self):
        r = self.pg.evaluate("() => [KB_DADOS.posEntre(null,null), KB_DADOS.posEntre(null,100), "
                             "KB_DADOS.posEntre(100,null), KB_DADOS.posEntre(1,2), KB_DADOS.posEntre(1,1)]")
        self.assertEqual(r, [65536, 50, 65636, 1.5, None])

    def test_markdown_so_deixa_link_seguro(self):
        for perigoso in ("[x](javascript:alert(1))", "![a](javascript:alert(1))",
                         "[x](data:text/html,oi)", "<img src=x onerror=alert(1)>",
                         '[a"onmouseover="x](https://x.com/"onmouseover="alert(1))'):
            h = self.md(perigoso)
            self.assertNotIn("javascript:", h, perigoso)
            self.assertNotIn("<img", h, perigoso)
            self.assertNotRegex(h, r'\son\w+="', perigoso)

    def test_markdown_do_board(self):
        h = self.md("# Título\n**neg** e _it_\n- a\n  - b\n> citação\n\nveja anexo:trello/x/arq.pdf")
        self.assertIn("<h3>Título</h3>", h)
        self.assertIn("<strong>neg</strong>", h)
        self.assertIn("<ul><li>a<ul><li>b</li></ul></li></ul>", h)
        self.assertIn("<blockquote>", h)
        self.assertIn('data-anexo="trello/x/arq.pdf"', h)

    def test_sublinhado_em_nome_de_arquivo_nao_vira_italico(self):
        self.assertNotIn("<em>", self.md("Extrato_de_Cotista_1958_V2.pdf"))

    def test_mencao_e_email(self):
        h = self.md("@fulano123 e alguem@luxor.com.br")
        self.assertIn("@Fulano", h)
        self.assertIn("alguem@luxor.com.br", h, "e-mail não vira menção")

    def test_frases(self):
        f = self.pg.evaluate("""() => [
          KB_DADOS.frase({tipo:'moveu', dados:{de:'To Do', para:'Done'}}),
          KB_DADOS.frase({tipo:'membro_entrou', autor_nome:'Aline', dados:{membro:'Aline'}}),
          KB_DADOS.frase({tipo:'item_concluido', dados:{item:'<b>x</b>', card:'C'}}, true),
          KB_DADOS.frase({tipo:'trello_algo', dados:{}})]""")
        self.assertEqual(f[0], "moveu este card de <b>To Do</b> para <b>Done</b>")
        self.assertEqual(f[1], "entrou neste card")
        self.assertIn("&lt;b&gt;x&lt;/b&gt;", f[2], "nome vindo de usuário é escapado")
        self.assertIn("em <b>C</b>", f[2])
        self.assertIn("alteração no Trello", f[3])


if __name__ == "__main__":
    unittest.main(verbosity=2)
