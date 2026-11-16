"""Testa a aba Senhas com o supabase-js REAL e a rede interceptada (mesma abordagem do
Kanban): um PostgREST de mentira responde às tabelas senhas_*, e os dados de teste são
cifrados pelo PYTHON que o import usa (tools/senhas_cifra.py) — então o teste também prova
que a cifra do import e a do navegador (sh_cripto.js) são a mesma, nos dois sentidos.

Roda sem credencial e sem tocar no Supabase de verdade. Precisa de `cryptography`.

Uso: python assets/senhas/test_painel.py   (da raiz do repo do hub)
"""

import base64
import copy
import json
import pathlib
import sys
import unittest
import urllib.parse

AQUI = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI.parent.parent / "tools"))
import senhas_cifra as IMP  # noqa: E402

SENHA = "mestra-de-teste"
SAL = b"0123456789abcdef"
ITER = 100_000
K = IMP.chave(SENHA, SAL, ITER)
c = lambda t: IMP.cifrar(K, t)

L_ABERTA, L_VELHA = "l-aberta", "l-velha"
ARQ = b"conteudo do anexo \x00\x01\x02"

BASE = {
    "senhas_cofre": [{"id": 1, "sal": base64.b64encode(SAL).decode(), "iteracoes": ITER,
                      "verificador": c(IMP.VERIFICADOR)}],
    "senhas_listas": [
        {"id": L_ABERTA, "nome": c("Senhas"), "pos": 100, "arquivada": False},
        {"id": L_VELHA, "nome": c("Antigas"), "pos": 200, "arquivada": True},
    ],
    "senhas_itens": [
        {"id": "i-banco", "lista_id": L_ABERTA, "titulo": c("Banco Fulano"), "conteudo": c("login: ana\nsenha: S3gr3d0!"),
         "pos": 100, "arquivado": False, "atualizado_em": "2026-11-10T12:00:00Z"},
        {"id": "i-xss", "lista_id": L_ABERTA, "titulo": c('<img src=x onerror="window.__xss=1">'), "conteudo": c("x"),
         "pos": 200, "arquivado": False, "atualizado_em": "2026-11-10T12:00:00Z"},
        {"id": "i-arq", "lista_id": L_ABERTA, "titulo": c("Sistema velho"), "conteudo": c("aposentado"),
         "pos": 300, "arquivado": True, "atualizado_em": "2026-11-01T12:00:00Z"},
        {"id": "i-lv", "lista_id": L_VELHA, "titulo": c("Item de lista arquivada"), "conteudo": c(""),
         "pos": 100, "arquivado": False, "atualizado_em": "2026-11-01T12:00:00Z"},
    ],
    "senhas_comentarios": [
        {"id": "m1", "item_id": "i-banco", "texto": c("trocada em nov/26"), "autor": "Fulano", "criado_em": "2026-11-12T12:00:00Z"},
    ],
    "senhas_anexos": [
        {"id": "a1", "item_id": "i-banco", "nome": c("token.txt"), "caminho": "a1.bin", "tamanho": len(ARQ),
         "criado_em": "2026-11-12T12:00:00Z"},
    ],
}
OBJETOS = {"a1.bin": IMP.cifrar_bytes(K, ARQ)}


def _filtros(query):
    out = {}
    for k, v in urllib.parse.parse_qsl(query):
        if v.startswith("eq."):
            out[k] = v[3:]
    return out


class Fake:
    def __init__(self):
        self.db = copy.deepcopy(BASE)
        self.objetos = dict(OBJETOS)
        self.escritas = []     # (método, tabela, filtros, corpo)
        self.seq = 0

    def get(self, tabela, query):
        f = _filtros(query)
        return [x for x in self.db.get(tabela, []) if all(str(x.get(k)) == v for k, v in f.items())]

    def post(self, tabela, corpo):
        out = []
        for l in (corpo if isinstance(corpo, list) else [corpo]):
            self.seq += 1
            l = {"id": f"novo-{self.seq}", "arquivado": False, "atualizado_em": "2026-11-16T12:00:00Z",
                 "criado_em": "2026-11-16T12:00:00Z", "autor": "fulano@luxor.com.br", "arquivada": False, **l}
            self.db.setdefault(tabela, []).append(l)
            out.append(l)
        return out

    def patch(self, tabela, query, corpo):
        alvo = self.get(tabela, query)
        for x in alvo:
            x.update(corpo)
        return alvo

    def delete(self, tabela, query):
        alvo = self.get(tabela, query)
        self.db[tabela] = [x for x in self.db[tabela] if x not in alvo]
        return alvo


class TestSenhas(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def setUp(self):
        self.fake = Fake()
        self.erros = []
        self.ctx = self._b.new_context(viewport={"width": 1300, "height": 900}, accept_downloads=True)
        pg = self.pg = self.ctx.new_page()
        pg.on("pageerror", lambda e: self.erros.append(str(e)))
        pg.on("dialog", lambda d: d.accept())
        fake = self.fake

        def rota(route, request):
            partes = urllib.parse.urlsplit(request.url)
            caminho, query, metodo = partes.path, partes.query, request.method
            objeto = "vnd.pgrst.object" in (request.headers.get("accept") or "")

            def responder(dados, status=200):
                if objeto and isinstance(dados, list):
                    dados = dados[0] if dados else None
                return route.fulfill(status=status, content_type="application/json", body=json.dumps(dados))

            if caminho.startswith("/storage/v1/object/senhas"):
                nome = caminho[len("/storage/v1/object/senhas/"):]
                if metodo == "GET":
                    return route.fulfill(status=200, content_type="application/octet-stream", body=fake.objetos[nome])
                if metodo == "POST":
                    fake.objetos[nome] = request.post_data_buffer
                    fake.escritas.append(("POST", "storage", {}, nome))
                    return responder({"Key": "senhas/" + nome})
                fake.escritas.append((metodo, "storage", {}, request.post_data))
                return responder([])
            if caminho.startswith("/rest/v1/"):
                tabela = caminho[len("/rest/v1/"):]
                if metodo == "GET":
                    return responder(fake.get(tabela, query))
                corpo = json.loads(request.post_data) if request.post_data else None
                fake.escritas.append((metodo, tabela, _filtros(query), corpo))
                if metodo == "POST":
                    return responder(fake.post(tabela, corpo), 201)
                if metodo == "PATCH":
                    return responder(fake.patch(tabela, query, corpo))
                if metodo == "DELETE":
                    return responder(fake.delete(tabela, query))
            return route.fulfill(status=404, body="")

        pg.route("**/*.supabase.co/**", rota)
        pg.add_init_script("window.__xss = 0;")
        pg.goto((AQUI / "index.html").as_uri())

    def tearDown(self):
        self.ctx.close()
        self.assertEqual(self.erros, [])

    def entrar(self, senha=SENHA):
        self.pg.fill("#mestra", senha)
        self.pg.click("#bAbrir")

    def ultima(self, metodo, tabela):
        for m, t, f, corpo in reversed(self.fake.escritas):
            if m == metodo and t == tabela:
                return f, corpo
        self.fail(f"nenhum {metodo} em {tabela}")

    # ------------------------------------------------------------------
    def test_senha_errada_nao_abre(self):
        self.entrar("errada")
        self.pg.wait_for_function("document.querySelector('#msgTrava').textContent.length > 0", timeout=15000)
        self.assertIn("não confere", self.pg.text_content("#msgTrava"))
        self.assertTrue(self.pg.is_hidden("#app"))

    def test_abre_e_decifra_a_lista(self):
        self.entrar()
        self.pg.wait_for_selector(".item", timeout=15000)
        nomes = self.pg.eval_on_selector_all(".item .t", "els => els.map(e => e.textContent)")
        self.assertIn("Banco Fulano", nomes)
        self.assertNotIn("Sistema velho", nomes)            # arquivado
        self.assertNotIn("Item de lista arquivada", nomes)  # lista arquivada
        self.assertEqual(self.pg.evaluate("window.__xss"), 0)
        self.assertIn('<img src=x', " ".join(nomes))        # virou texto, não tag
        # busca também no conteúdo (decifrado só na memória)
        self.pg.fill("#busca", "s3gr3d0")
        self.assertEqual(self.pg.eval_on_selector_all(".item .t", "els => els.map(e => e.textContent)"), ["Banco Fulano"])
        # arquivados
        self.pg.fill("#busca", "")
        self.pg.click("#bArq")
        nomes = self.pg.eval_on_selector_all(".item .t", "els => els.map(e => e.textContent)")
        self.assertEqual(sorted(nomes), ["Item de lista arquivada", "Sistema velho"])

    def test_item_salva_comenta_e_anexo_cifrados(self):
        self.entrar()
        self.pg.wait_for_selector("[data-item='i-banco']", timeout=15000)
        self.pg.click("[data-item='i-banco']")
        self.pg.wait_for_selector(".coment", timeout=5000)
        self.assertTrue(self.pg.eval_on_selector("#pCaixa", "e => e.classList.contains('oculto')"))
        self.assertIn("trocada em nov/26", self.pg.text_content("#pComents"))
        self.assertIn("token.txt", self.pg.text_content("#pAnexos"))

        # salvar: o que sai para o banco é cifra que o Python decifra
        self.pg.click("#pMostrar")
        self.pg.fill("#pTitulo", "Banco Fulano PJ")
        self.pg.fill("#pConteudo", "login: ana\nsenha: N0v4!")
        self.pg.click("#pSalvar")
        self.pg.wait_for_function("document.querySelector('#pMsg').textContent === 'Salvo.'", timeout=5000)
        f, corpo = self.ultima("PATCH", "senhas_itens")
        self.assertEqual(f, {"id": "i-banco"})
        self.assertTrue(corpo["titulo"].startswith("v1:") and corpo["conteudo"].startswith("v1:"))
        self.assertEqual(IMP.decifrar(K, corpo["titulo"]), "Banco Fulano PJ")
        self.assertEqual(IMP.decifrar(K, corpo["conteudo"]), "login: ana\nsenha: N0v4!")

        # comentar
        self.pg.fill("#pNovoComent", "senha nova vale até mar/27")
        self.pg.click("#pComentar")
        self.pg.wait_for_function("document.querySelectorAll('.coment').length === 2", timeout=5000)
        _, corpo = self.ultima("POST", "senhas_comentarios")
        self.assertEqual(IMP.decifrar(K, corpo["texto"]), "senha nova vale até mar/27")

        # baixar o anexo: o arquivo sai decifrado
        with self.pg.expect_download() as d:
            self.pg.click("[data-baixar='a1']")
        self.assertEqual(pathlib.Path(d.value.path()).read_bytes(), ARQ)

        # anexar: sobe cifrado, com o nome cifrado
        self.pg.set_input_files("#pArquivo", files=[{"name": "novo.txt", "mimeType": "text/plain", "buffer": b"segredo"}])
        self.pg.wait_for_function("document.querySelectorAll('.anexo').length === 2", timeout=5000)
        _, corpo = self.ultima("POST", "senhas_anexos")
        self.assertEqual(IMP.decifrar(K, corpo["nome"]), "novo.txt")
        self.assertEqual(IMP.decifrar_bytes(K, self.fake.objetos[corpo["caminho"]]), b"segredo")

        # nada em claro em escrita nenhuma
        texto = json.dumps([e[3] for e in self.fake.escritas if e[1] != "storage"], ensure_ascii=False)
        for claro in ("Banco Fulano PJ", "N0v4!", "senha nova", "novo.txt"):
            self.assertNotIn(claro, texto)

    def test_novo_item_e_bloquear(self):
        self.entrar()
        self.pg.wait_for_selector(".item", timeout=15000)
        self.pg.click("#bNovo")
        self.pg.wait_for_selector("#pTitulo", timeout=5000)
        _, corpo = self.ultima("POST", "senhas_itens")
        self.assertEqual(corpo["lista_id"], L_ABERTA)
        self.assertEqual(IMP.decifrar(K, corpo["titulo"]), "Novo item")
        self.pg.click("#bBloq")
        self.assertTrue(self.pg.is_visible("#trava"))
        self.assertTrue(self.pg.is_hidden("#painel"))
        self.assertEqual(self.pg.inner_html("#lista"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
