"""Testa a página dos manuais com o supabase-js REAL e a rede interceptada.

Mesma abordagem dos outros painéis: nada de credencial ou Supabase de verdade — o que o
supabase-js pede é atendido aqui, o que também confere que a página pede as coisas certas
(app_state com a guarda de concorrência, RPC de permissão, URLs assinadas dos prints).

O conteúdo é SINTÉTICO: o repositório é público e o manual real fica no banco.

Uso: python assets/manuais/test_painel.py   (da raiz do repo do hub)
"""

import base64
import json
import pathlib
import time
import unittest
import urllib.parse

AQUI = pathlib.Path(__file__).resolve().parent
MANUAL = "manual_backoffice"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")

MD_A = """Intro da seção A.

## Passo um

1. Primeiro
2. Segundo
   - detalhe aninhado

![Tela do sistema](img/tela.png)

3. Terceiro continua a contagem

```
cd "C:\\pasta\\exemplo"
python script.py --mes MM/AAAA
```

| Coluna | Valor |
|---|---|
| a | `x` |

> Destaque importante.

Ver também [a seção B](#s=secao-b) e [site](https://exemplo.com).

<script>window.__xss = 1</script> **negrito** e *itálico*.

Antes **apaga `base_x` tudo** depois e [link `cod`](#s=secao-b).
"""


def _doc():
    return {"versao": 1, "titulo": "Manual de Teste", "secoes": [
        {"id": "secao-a", "titulo": "Seção A", "periodicidade": "Mensal", "md": MD_A,
         "atualizado_em": "2026-11-01T10:00:00+00:00", "atualizado_por": "fulano.tal@exemplo.com"},
        {"id": "secao-b", "titulo": "Seção B", "periodicidade": "Trimestral",
         "md": "## Outro\n\nTexto sobre conciliação de carteiras.",
         "atualizado_em": "2026-11-02T10:00:00+00:00", "atualizado_por": None},
    ]}


class Estado:
    def __init__(self, editor=False):
        self.doc = _doc()
        self.versao = "2026-11-02T10:00:00+00:00"
        self.editor = editor
        self.gravacoes = []
        self.envios = []
        self.conflito_secao = None   # (id, novo atualizado_em): outra pessoa grava no meio


def _abrir(caso, estado, hash_=""):
    from playwright.sync_api import sync_playwright

    cls = type(caso)
    if not hasattr(cls, "_pw"):
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
    erros = []
    pg = cls._b.new_page(viewport={"width": 1500, "height": 900})
    pg.on("pageerror", lambda e: erros.append(str(e)))

    def rota(route, request):
        url = request.url
        if "/rest/v1/rpc/hub_manual_pode_editar" in url:
            assert json.loads(request.post_data) == {"m": MANUAL}
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(estado.editor))
        if "/rest/v1/app_state" in url:
            assert f"id=eq.{MANUAL}" in url
            if request.method == "PATCH":
                pedida = urllib.parse.unquote(url.split("updated_at=eq.")[1].split("&")[0])
                if pedida != estado.versao:
                    return route.fulfill(status=200, content_type="application/json", body="[]")
                corpo = json.loads(request.post_data)
                estado.gravacoes.append(corpo)
                estado.doc = corpo["data"]
                estado.versao = corpo["updated_at"]
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps([{"id": MANUAL, "updated_at": estado.versao}]))
            if estado.conflito_secao:
                sid, quando = estado.conflito_secao
                for s in estado.doc["secoes"]:
                    if s["id"] == sid:
                        s["atualizado_em"] = quando
                        s["atualizado_por"] = "outra.pessoa@exemplo.com"
                estado.versao = quando
                estado.conflito_secao = None
            return route.fulfill(status=200, content_type="application/vnd.pgrst.object+json",
                                 body=json.dumps({"data": estado.doc, "updated_at": estado.versao}))
        if "/storage/v1/object/sign/manuais" in url and request.method == "POST":
            paths = json.loads(request.post_data)["paths"]
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(
                [{"path": p, "signedURL": f"/object/sign/manuais/{p}?token=t", "error": None} for p in paths]))
        if "/storage/v1/object/sign/manuais/" in url:
            return route.fulfill(status=200, content_type="image/png", body=PNG)
        if "/storage/v1/object/manuais/" in url and request.method == "POST":
            estado.envios.append(url.split("/storage/v1/object/manuais/")[1])
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"Key": "manuais/x", "Id": "1"}))
        return route.continue_()

    pg.route("**/*.supabase.co/**", rota)
    # sessão de mentira: o carimbo "atualizado_por" sai do e-mail dela
    sessao = {"access_token": "x", "refresh_token": "y", "token_type": "bearer", "expires_in": 3600,
              "expires_at": int(time.time()) + 3600, "user": {"id": "u1", "email": "editor.teste@exemplo.com"}}
    pg.add_init_script(f"localStorage.setItem('sb-hjducsxcolbspbkpflom-auth-token', {json.dumps(json.dumps(sessao))});")
    pg.goto((AQUI / "index.html").as_uri() + f"?manual={MANUAL}" + hash_)
    pg.wait_for_selector("#secao .md, #secao .vazio h2", timeout=8000)
    pg.wait_for_timeout(300)
    return pg, erros


class TestManuais(unittest.TestCase):
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

    def test_1_abre_na_primeira_secao_com_o_markdown_desenhado(self):
        pg, erros = _abrir(self, Estado())
        self.assertEqual(erros, [])
        self.assertEqual(pg.text_content("#titulo"), "Manual de Teste")
        self.assertEqual(pg.text_content("#secao h1"), "Seção A")
        self.assertIn("01/11/2026 por Fulano Tal", pg.text_content("#secao .meta"))
        md = "#secao .md"
        self.assertEqual(pg.locator(f"{md} ol").nth(1).get_attribute("start"), "3")
        self.assertEqual(pg.locator(f"{md} ol li ul li").text_content(), "detalhe aninhado")
        self.assertIn('python script.py', pg.text_content(f"{md} .cod code"))
        self.assertEqual(pg.locator(f"{md} table td").count(), 2)
        self.assertIn("Destaque", pg.text_content(f"{md} blockquote"))
        self.assertIn("/object/sign/manuais/manual_backoffice/tela.png", pg.get_attribute(f"{md} figure img", "src"))
        self.assertEqual(pg.get_attribute(f'{md} a[href^="https"]', "target"), "_blank")
        # nada do texto vira tag
        self.assertIsNone(pg.evaluate("window.__xss"))
        self.assertIn("<script>", pg.text_content(md))
        self.assertEqual(pg.locator(f"{md} strong").count(), 2)
        self.assertEqual(pg.locator(f"{md} strong code").text_content(), "base_x")   # negrito atravessa código
        self.assertEqual(pg.locator(f'{md} a[href="#s=secao-b"] code').count(), 1)
        # leitor sem permissão não vê botão de edição
        self.assertFalse(pg.is_visible("#nova"))
        self.assertEqual(pg.locator("#secao button[data-a]").count(), 0)
        pg.close()

    def test_2_indice_busca_e_link_entre_secoes(self):
        pg, erros = _abrir(self, Estado())
        self.assertEqual(pg.locator("#indice .sub").count(), 1)   # "Passo um" da seção aberta
        pg.fill("#busca", "conciliação")
        self.assertEqual(pg.locator("#indice .item").count(), 1)
        self.assertIn("Seção B", pg.text_content("#indice"))
        pg.fill("#busca", "")
        pg.click('#secao a[href="#s=secao-b"]')
        pg.wait_for_selector("#secao h1:text-is('Seção B')")
        self.assertEqual(pg.text_content("#secao h1"), "Seção B")
        self.assertEqual(erros, [])
        pg.close()

    def test_3_editor_grava_so_a_secao_com_a_guarda(self):
        est = Estado(editor=True)
        pg, erros = _abrir(self, est, "#s=secao-b")
        self.assertTrue(pg.is_visible("#nova"))
        pg.click('#secao button[data-a="editar"]')
        pg.fill("#ed-md", "## Novo\n\n- item editado")
        pg.wait_for_selector("#ed-previa li")   # a prévia redesenha 200 ms depois de digitar
        self.assertIn("item editado", pg.text_content("#ed-previa"))
        pg.click("#ed-salvar")
        pg.wait_for_selector("#secao header.cab")   # o editor saiu e a seção foi redesenhada
        self.assertEqual(erros, [])
        self.assertEqual(len(est.gravacoes), 1)
        secoes = est.gravacoes[0]["data"]["secoes"]
        self.assertEqual(secoes[0]["md"], MD_A)                    # a outra seção intacta
        self.assertEqual(secoes[1]["md"], "## Novo\n\n- item editado")
        self.assertEqual(secoes[1]["atualizado_por"], "editor.teste@exemplo.com")
        self.assertIn("Editor Teste", pg.text_content("#secao .meta"))
        pg.close()

    def test_4_mesma_secao_alterada_por_outro_recusa_sem_gravar(self):
        est = Estado(editor=True)
        pg, erros = _abrir(self, est, "#s=secao-b")
        pg.click('#secao button[data-a="editar"]')
        pg.fill("#ed-md", "minha versão")
        est.conflito_secao = ("secao-b", "2026-11-03T09:00:00+00:00")
        pg.click("#ed-salvar")
        pg.wait_for_selector("#status.erro")
        self.assertEqual(est.gravacoes, [])
        self.assertIn("Outra Pessoa", pg.text_content("#status"))
        self.assertEqual(pg.input_value("#ed-md"), "minha versão")   # o texto não se perde
        self.assertEqual(erros, [])
        pg.close()

    def test_5_nova_secao_e_print_colado(self):
        est = Estado(editor=True)
        pg, erros = _abrir(self, est)
        pg.click("#nova")
        pg.fill("#ed-titulo", "Rotina Nova")
        pg.set_input_files("#ed-arq", files=[{"name": "p.png", "mimeType": "image/png", "buffer": PNG}])
        pg.wait_for_function("document.querySelector('#ed-md').value.includes('](img/')")
        self.assertEqual(len(est.envios), 1)
        self.assertTrue(est.envios[0].startswith(f"{MANUAL}/"))
        self.assertRegex(pg.input_value("#ed-md"), r"!\[\]\(img/\d{14}_[a-z0-9]+\.png\)")
        pg.click("#ed-salvar")
        pg.wait_for_selector("#secao h1:text('Rotina Nova')")
        self.assertEqual([s["id"] for s in est.doc["secoes"]], ["secao-a", "secao-b", "rotina-nova"])
        self.assertEqual(erros, [])
        pg.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
