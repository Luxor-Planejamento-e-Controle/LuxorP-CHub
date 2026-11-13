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
import types
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
        {"id": "i3", "checklist_id": "k1", "nome": "Arquivar no Drive", "pos": 3, "concluido": False,
         "membro_id": None, "prazo": None},
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
        {"id": "a2", "card_id": "c-fech", "nome": "foto.png", "caminho": "trello/y/foto.png",
         "url": None, "mime": "image/png", "bytes": 2000, "autor_nome": "Aline",
         "autor_email": "alguem@luxor.com.br", "criado_em": "2026-11-04T09:30:00Z", "pos": 2},
    ],
    "kanban_seguidores": [],
    "kanban_reacoes": [{"id": "r1", "comentario_id": "cm1", "emoji": "👍", "autor_nome": "Fulano de Tal",
                        "autor_email": EU}],
    # foto do Slack (hub_fotos): só o Fulano tem
    "hub_fotos": [{"email": EU, "foto_url": "https://avatars.slack-edge.com/teste/fulano_192.png"}],
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
        capa = next((a for a in self.db["kanban_anexos"] if a["id"] == c.get("capa_anexo_id")), None)
        return {**c,
                "capa": {"caminho": capa["caminho"], "nome": capa["nome"]} if capa else None,
                "kanban_seguidores": [{"membro_id": x["membro_id"]} for x in self.db["kanban_seguidores"] if x["card_id"] == c["id"]],
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
                linhas = [c for c in linhas if self._casa(c, {k: v for k, v in f.items() if k in ("id", "arquivado", "modelo")})]
            return [self.card_resumo(c) for c in linhas]
        if tabela == "kanban_comentarios":
            return [{**m, "kanban_reacoes": [r for r in self.db["kanban_reacoes"] if r["comentario_id"] == m["id"]]}
                    for m in self.db["kanban_comentarios"] if self._casa(m, f)]
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
            if tabela in ("kanban_comentarios", "kanban_reacoes"):   # o gatilho carimba o autor
                l.update({"autor_nome": "Fulano de Tal", "autor_email": EU, "criado_em": "2026-11-12T12:00:00Z"})
                if tabela == "kanban_comentarios":
                    l["editado_em"] = None
                l.setdefault("id", f"novo-{self.seq}")
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


def _pagina(cls, hash_=""):
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
            # corpo binário (o arquivo): post_data tentaria decodificar como texto
            cls.fake.escritas.append((metodo, "storage", caminho, len(request.post_data_buffer or b"")))
            return responder({"Key": caminho})
        if caminho == "/rest/v1/rpc/kanban_entrar":
            return responder(M_EU)
        if caminho == "/rest/v1/rpc/kanban_buscar":
            q = json.loads(request.post_data)["p_texto"].lower()
            db = cls.fake.db
            achados = []
            for c in db["kanban_cards"]:
                kls = [k["id"] for k in db["kanban_checklists"] if k["card_id"] == c["id"]]
                if any(q in i["nome"].lower() for i in db["kanban_checkitens"] if i["checklist_id"] in kls):
                    achados.append({"card_id": c["id"], "nome": c["nome"], "lista_id": c["lista_id"],
                                    "arquivado": c["arquivado"], "arquivado_em": c["arquivado_em"], "onde": "checklist"})
            return responder(achados)
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
    pg.route("https://avatars.slack-edge.com/**",
             lambda route, req: route.fulfill(status=200, content_type="image/png", body=PNG_1PX))
    pg.add_init_script(f"window.HUB = {{email:'{EU}'}}; window.__xss = 0;")
    pg.goto((AQUI / "index.html").as_uri() + hash_)
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
        self.assertIn("1/3", txt, "itens do checklist feitos/total")
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

    def test_07_foto_do_slack_no_avatar(self):
        pg = self.pg
        pg.wait_for_timeout(300)
        face = pg.locator('.kcard[data-id="c-fech"] .mbrs .av').first
        self.assertTrue(face.locator("img").evaluate("i => i.complete && i.naturalWidth > 0"),
                        "quem tem foto no Slack aparece com a foto")
        dre = pg.locator('.kcard[data-id="c-dre"] .mbrs .av').first
        self.assertEqual(dre.locator("img").count(), 0, "quem não tem foto fica com as iniciais")
        self.assertEqual(dre.inner_text().strip(), "A")

    def test_08_botao_tela_cheia(self):
        self.assertEqual(self.pg.locator("#btTelaCheia").count(), 1)

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

    def test_16b_arrastar_ate_a_borda_rola_o_board(self):
        pg = self.pg
        self._fechar()
        pg.set_viewport_size({"width": 620, "height": 700})   # board mais largo que a tela
        try:
            pg.evaluate("document.getElementById('board').scrollLeft = 0")
            pg.evaluate("""() => {
              window.__dt = new DataTransfer();
              document.querySelector('.kcard').dispatchEvent(
                new DragEvent('dragstart', {bubbles: true, dataTransfer: window.__dt}));
              const r = document.getElementById('board').getBoundingClientRect();
              document.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true,
                clientX: r.right - 8, clientY: r.top + 120, dataTransfer: window.__dt}));
            }""")
            pg.wait_for_timeout(500)
            rolou = pg.evaluate("document.getElementById('board').scrollLeft")
            self.assertGreater(rolou, 0, "card na borda direita rola o board para o lado")
            pg.evaluate("""() => document.querySelector('.kcard.arrastando, .kcard').dispatchEvent(
                new DragEvent('dragend', {bubbles: true, dataTransfer: window.__dt}))""")
            pg.wait_for_timeout(100)
            parado = pg.evaluate("document.getElementById('board').scrollLeft")
            pg.wait_for_timeout(300)
            self.assertEqual(pg.evaluate("document.getElementById('board').scrollLeft"), parado,
                             "soltou o card, a rolagem para")
        finally:
            pg.set_viewport_size({"width": 1500, "height": 950})
            pg.evaluate("document.getElementById('board').scrollLeft = 0")

    def test_17_busca_acha_item_de_checklist(self):
        pg = self.pg
        self._fechar()
        pg.fill("#fTexto", "enviar ao board")      # só existe como item do checklist
        pg.wait_for_timeout(900)
        self.assertEqual([e.get_attribute("data-id") for e in pg.locator(".kcard").all()], ["c-fech"],
                         "a busca do banco acha o card pelo item do checklist")
        pg.fill("#fTexto", "")
        pg.wait_for_timeout(300)

    def test_18_botao_direito_arquiva_com_desfazer(self):
        pg = self.pg
        pg.click('.kcard[data-id="c-dre"]', button="right")
        pg.wait_for_selector(".pop")
        pg.click('.pop [data-q="arquivar"]')
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual((f, c), ({"id": "c-dre"}, {"arquivado": True}))
        self.assertEqual(pg.locator('.kcard[data-id="c-dre"]').count(), 0)
        pg.click("#btToast")                       # Desfazer
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual((f, c), ({"id": "c-dre"}, {"arquivado": False}))
        self.assertEqual(pg.locator('.kcard[data-id="c-dre"]').count(), 1, "voltou para o board")

    def test_19_sem_atalho_de_teclado_para_arquivar(self):
        pg = self.pg
        antes = len(self.fake.escritas)
        pg.focus('.kcard[data-id="c-dre"]')
        for tecla in ("c", "C", "Delete", "Backspace"):
            pg.keyboard.press(tecla)
        pg.wait_for_timeout(300)
        self.assertEqual(len(self.fake.escritas), antes, "nenhuma tecla grava nada no card")

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

    # ---------------- o resto do Trello ----------------

    def test_50_reacoes(self):
        pg = self.pg
        self._abrir()
        meu = pg.locator('[data-coment="cm1"] .reacao.minha')
        self.assertIn("👍 1", meu.inner_text(), "a reação veio do banco, e é minha")
        meu.click()
        pg.wait_for_timeout(500)
        f, _c = _ultima(self, "DELETE", "kanban_reacoes")
        self.assertEqual(f, {"comentario_id": "cm1", "emoji": "👍", "autor_email": EU}, "clicar na sua tira a sua")
        pg.hover('[data-coment="cm1"]')
        pg.click('[data-coment="cm1"] [data-a="add-reacao"]')
        pg.click('.emojis [data-emoji="👏"]')
        pg.wait_for_timeout(500)
        _f, c = _ultima(self, "POST", "kanban_reacoes")
        self.assertEqual(c, {"comentario_id": "cm1", "emoji": "👏"}, "autor não vai da tela")

    def test_51_datas_com_inicio_e_lembrete(self):
        pg = self.pg
        self._abrir()
        pg.click('.dlg-side [data-a="prazo"]')
        pg.check("#inTemInicio")
        pg.fill("#inInicio", "2026-11-20T09:00")
        pg.fill("#inPrazo", "2026-11-27T18:00")
        pg.select_option("#inLembrete", "15")
        pg.click('[data-p="salvar"]')
        pg.wait_for_timeout(500)
        _f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual(c["lembrete_min"], 15)
        self.assertTrue(c["inicio"].startswith("2026-11-2") and c["prazo"].startswith("2026-11-2"))
        self.assertIn("20 – 27 nov", pg.inner_text('.kcard[data-id="c-fech"]'), "início e prazo no card")

    def test_52_copiar_com_anexos_e_comentarios(self):
        pg = self.pg
        self._abrir()
        pg.click('.dlg-side [data-a="copiar"]')
        pg.click('[data-c="ok"]')
        pg.wait_for_timeout(600)
        _f, c = _ultima(self, "RPC", "kanban_copiar_card")
        self.assertTrue(c["p_anexos"] and c["p_comentarios"], "como no Trello, mantém tudo por padrão")

    def test_53_tornar_modelo_e_criar_a_partir_dele(self):
        pg = self.pg
        self._abrir()
        pg.click('.dlg-side [data-a="tornar-modelo"]')
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual((f, c), ({"id": "c-fech"}, {"modelo": True}))
        pg.click('[data-a="criar-do-modelo"]')
        self.assertFalse(pg.locator("#cpCom").is_checked(), "do modelo não vêm os comentários")
        pg.fill("#inCpNome", "Novo a partir do modelo")
        pg.click('[data-c="ok"]')
        pg.wait_for_timeout(600)
        _f, c = _ultima(self, "RPC", "kanban_copiar_card")
        self.assertEqual(c["p_nome"], "Novo a partir do modelo")
        self._fechar()

    def test_54_filtro_sem_etiqueta(self):
        pg = self.pg
        self._fechar()
        pg.click("#fEtiquetas")
        pg.click('.pop [data-sem="1"]')
        pg.wait_for_timeout(200)
        ids = [e.get_attribute("data-id") for e in pg.locator(".kcard").all()]
        self.assertIn("c-xss", ids)
        self.assertNotIn("c-dre", ids)
        pg.keyboard.press("Escape")
        pg.click("#fLimpar")

    def test_55_recolher_lista(self):
        pg = self.pg
        pg.click(f'.kcol[data-lista="{L_TODO}"] [data-acao="menu-lista"]')
        pg.click('.pop [data-a="recolher"]')
        self.assertEqual(pg.locator(f'.kcol.recolhida[data-lista="{L_TODO}"]').count(), 1)
        pg.click(f'.kcol.recolhida[data-lista="{L_TODO}"] .vertical')
        self.assertEqual(pg.locator(f'.kcol.recolhida[data-lista="{L_TODO}"]').count(), 0)

    def test_56_ordenar_lista_por_nome(self):
        pg = self.pg
        antes = len(self.fake.escritas)
        pg.click(f'.kcol[data-lista="{L_TODO}"] [data-acao="menu-lista"]')
        pg.click('.pop [data-a="ordenar"]')
        pg.click('.pop [data-o="nome"]')
        pg.wait_for_timeout(700)
        novas = [e for e in self.fake.escritas[antes:] if e[0] == "PATCH" and e[1] == "kanban_cards"]
        self.assertTrue(novas and all(set(c) == {"pos"} for _m, _t, _f, c in novas), "renumera as posições")

    def test_57_visualizador_de_anexo(self):
        pg = self.pg
        self._abrir()
        pg.click('[data-anexo-id="a2"] .nome')
        pg.wait_for_selector(".visor-corpo img", timeout=5000)
        self.assertIn("2", pg.inner_text(".visor-barra"), "seta entre os 2 anexos")
        pg.keyboard.press("ArrowLeft")
        pg.wait_for_selector(".visor-corpo iframe", timeout=5000)     # o pdf abre aqui mesmo
        pg.keyboard.press("Escape")
        self.assertEqual(pg.locator(".visor").count(), 0)
        self.assertEqual(pg.locator("#ovl").count(), 1, "Esc fecha só o visualizador")

    def test_58_barra_de_formatacao(self):
        pg = self.pg
        pg.fill("#novoComent", "importante")
        pg.evaluate("() => document.getElementById('novoComent').setSelectionRange(0, 10)")
        pg.click('.fmt[data-alvo="novoComent"] [data-fmt="b"]')
        self.assertEqual(pg.input_value("#novoComent"), "**importante**")
        pg.fill("#novoComent", "")

    def test_59_arrastar_item_de_checklist(self):
        pg = self.pg
        pg.evaluate("""() => {
          const dt = new DataTransfer(), it = document.querySelector('[data-item="i1"]');
          it.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
          const r = document.querySelector('[data-item="i3"]').getBoundingClientRect();
          document.querySelector('[data-item="i3"]').dispatchEvent(new DragEvent('dragover',
            {bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.bottom - 2, dataTransfer: dt}));
          document.querySelector('.ph-item').dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
        }""")
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_checkitens")
        self.assertEqual(f, {"id": "i1"})
        self.assertEqual(c["checklist_id"], "k1")
        self.assertGreater(c["pos"], 3, "i1 foi para depois do i3")
        self._fechar()

    def test_60_arrastar_lista(self):
        pg = self.pg
        pg.evaluate(f"""() => {{
          const dt = new DataTransfer();
          document.querySelector('.kcol[data-lista="{L_DONE}"] .kcol-head').dispatchEvent(
            new DragEvent('dragstart', {{bubbles: true, dataTransfer: dt}}));
          const alvo = document.querySelector('.kcol[data-lista="{L_TODO}"]'), r = alvo.getBoundingClientRect();
          alvo.dispatchEvent(new DragEvent('dragover', {{bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 20, dataTransfer: dt}}));
          document.querySelector('.ph-lista').dispatchEvent(new DragEvent('drop', {{bubbles: true, cancelable: true, dataTransfer: dt}}));
        }}""")
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_listas")
        self.assertEqual(f, {"id": L_DONE})
        self.assertLess(c["pos"], 100, "Done foi para antes do To Do")
        pg.evaluate("() => document.querySelectorAll('.kcol').forEach(c => c.dispatchEvent(new DragEvent('dragend', {bubbles: true})))")

    def test_90_arquivar_todos_os_cards_da_lista(self):
        # por último: arquiva a lista onde o card dos outros testes foi parar
        self._fechar()
        pg = self.pg
        pg.once("dialog", lambda d: d.accept())
        pg.click(f'.kcol[data-lista="{L_WIP}"] [data-acao="menu-lista"]')
        pg.click('.pop [data-a="arquivar-cards"]')
        pg.wait_for_timeout(500)
        f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual(f, {"lista_id": L_WIP, "arquivado": "false"}, "só os abertos daquela lista")
        self.assertEqual(c, {"arquivado": True})

    # ---------------- recursos que o time usava no Trello ----------------

    def _abrir(self, card="c-fech"):
        self._fechar()
        self.pg.evaluate(f"() => KB_TELA.abrirCard('{card}')")
        self.pg.wait_for_selector("#ovl")
        self.pg.wait_for_timeout(300)

    def test_30_sugestao_ao_digitar_arroba(self):
        pg = self.pg
        self._abrir()
        pg.click("#novoComent")
        pg.keyboard.type("oi @")
        pg.wait_for_selector(".mencoes")
        self.assertIn("todos os membros do card", pg.inner_text(".mencoes"), "@card avisa todos os membros")
        self.assertNotIn("Grupo Luxor", pg.inner_text(".mencoes"), "quem não tem login não recebe aviso")
        pg.keyboard.type("ful")
        pg.wait_for_timeout(100)
        self.assertIn("Fulano de Tal", pg.inner_text(".mencoes"))
        pg.keyboard.press("Enter")
        self.assertEqual(pg.input_value("#novoComent"), "oi @fulano123 ",
                         "insere o @usuario, que é o que o banco procura para avisar")
        self.assertEqual(pg.locator(".mencoes").count(), 0)
        pg.fill("#novoComent", "")

    def test_31_print_colado_vira_anexo_e_imagem_no_texto(self):
        pg = self.pg
        pg.click("#novoComent")
        pg.evaluate("""() => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array([137,80,78,71])], 'image.png', {type: 'image/png'}));
          document.getElementById('novoComent').dispatchEvent(
            new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
        }""")
        pg.wait_for_timeout(800)
        _f, c = _ultima(self, "POST", "kanban_anexos")
        self.assertEqual(c["nome"], "image.png")
        self.assertTrue(c["caminho"].startswith("cards/c-fech/"))
        self.assertIn(f"![image.png](anexo:{c['caminho']})", pg.input_value("#novoComent"))
        self.assertTrue(any(t == "storage" for _m, t, _f2, _c in self.fake.escritas), "arquivo enviado ao bucket")
        pg.fill("#novoComent", "")

    def test_32_seguir_card(self):
        pg = self.pg
        pg.click('.dlg-side [data-a="seguir"]')
        pg.wait_for_timeout(500)
        _f, c = _ultima(self, "POST", "kanban_seguidores")
        self.assertEqual(c, {"card_id": "c-fech", "membro_id": M_EU})
        self.assertIn("Seguindo", pg.inner_text(".dlg-side"))

    def test_33_capa_so_para_imagem(self):
        pg = self.pg
        self.assertEqual(pg.locator('[data-anexo-id="a1"] [data-a="capa"]').count(), 0, "pdf não vira capa")
        pg.click('[data-anexo-id="a2"] [data-a="capa"]')
        pg.wait_for_timeout(600)
        f, c = _ultima(self, "PATCH", "kanban_cards")
        self.assertEqual((f, c), ({"id": "c-fech"}, {"capa_anexo_id": "a2"}))
        self.assertEqual(pg.locator('.kcard[data-id="c-fech"] .capa img').count(), 1, "capa aparece no board")

    def test_34_ocultar_marcados_e_converter_item(self):
        pg = self.pg
        self.assertEqual(pg.locator('[data-item="i1"]').count(), 1)
        pg.click('[data-a="ocultar-feitos"]')
        self.assertEqual(pg.locator('[data-item="i1"]').count(), 0, "item marcado some")
        pg.click('[data-a="ocultar-feitos"]')              # "Mostrar marcados"
        self.assertEqual(pg.locator('[data-item="i1"]').count(), 1)
        pg.hover('[data-item="i2"]')
        pg.click('[data-item="i2"] [data-a="converter-item"]')
        pg.wait_for_timeout(700)
        _f, c = _ultima(self, "POST", "kanban_cards")
        self.assertEqual(c["nome"], "Enviar ao board")
        f, _c = _ultima(self, "DELETE", "kanban_checkitens")
        self.assertEqual(f, {"id": "i2"})

    def test_35_link_do_card(self):
        url = self.pg.evaluate("() => linkDoCard('abc-123')")
        self.assertTrue(url.endswith("/#/kanban?card=abc-123"))

    def test_36_link_abre_o_card(self):
        # página à parte, com o próprio banco de mentira, para não mexer na desta suíte
        outra = types.SimpleNamespace(_pw=self._pw, _b=self._b)
        pg = _pagina(outra, "#card=c-fech")
        pg.wait_for_selector("#ovl", timeout=5000)
        self.assertIn("Fechamento Resultado", pg.input_value("#titulo"))
        self.assertEqual(outra.erros, [])
        pg.close()

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
