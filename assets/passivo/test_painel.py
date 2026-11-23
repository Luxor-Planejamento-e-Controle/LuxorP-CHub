"""Testa o painel do Passivo Hoteleiro no hub com o supabase-js REAL e a rede interceptada.

Mesma abordagem do painel do Tarituba (assets/tarituba/test_painel.py): nada de
credencial, sessão ou Supabase de verdade — as requisições do supabase-js são atendidas
aqui, o que também confere que o painel pede o arquivo e a função certos.

Igual ao Shiva (assets/shiva/test_painel.py): sobe SEM o card do Trello, e o cadastro
grava também as linhas do Resumo. O que é do Passivo: `bimer` em LISTA (o de-para N→1 —
o 2º código soma na linha do 1º). O payload é SINTÉTICO (nomes e valores inventados): o
repositório é público.

Uso: python assets/passivo/test_painel.py   (da raiz do repo do hub)
"""

import json
import pathlib
import unittest
import urllib.parse

AQUI = pathlib.Path(__file__).resolve().parent

REC, DESP, OUT = "03.1.1.01.01", "03.2.1.02.01", "03.2.1.02.99"


def _payload():
    """Forma real do que o Azure publica (extrair_passivo.montar), com dado inventado."""
    def nat(cod, nome, bloco, orc, real):
        return {"cod": cod, "nome": nome, "nome_bimer": nome, "id": cod, "bloco": bloco,
                "na_planilha": True, "orc": orc, "real": real, "tem_orc": True, "tem_mov": True}

    z = [0.0] * 10
    nats = [nat(REC, "RECEITA A", "receita", [1000.0] * 12, [1100.0, 900.0] + z),
            nat(DESP, "DESPESA A", "despesa", [-300.0] * 12, [-300.0, -320.0] + z),
            nat(OUT, "OUTRA DESPESA", "despesa", [-200.0] * 12, [-200.0, 0.0] + z)]

    def soma(bloco, campo):
        return [sum(n[campo][i] for n in nats if n["bloco"] == bloco) for i in range(12)]

    receita, despesa = soma("receita", "real"), soma("despesa", "real")
    orc_r, orc_d = soma("receita", "orc"), soma("despesa", "orc")
    variacao = [receita[i] + despesa[i] for i in range(12)]
    saldo, acc = [], 10000.0
    for v in variacao:
        acc += v
        saldo.append(round(acc, 2))
    g = lambda nome, nivel: {"tipo": "grupo", "lin": 0, "nome": nome, "nivel": nivel}
    n = lambda nome, nivel, cod: {"tipo": "natureza", "lin": 0, "nome": nome, "nivel": nivel,
                                  "cod": cod, "fora_do_bloco": False}
    mensal = []
    for i in range(12):
        reg = {"mes": i + 1, "valores": {"c1": None, "c2": None}, "preenchido": False,
               "total": None, "fonte": None}
        if i < 2:   # jan e fev com saldo, e o saldo bate com o fluxo (Confronto 0,00)
            reg.update(valores={"c1": saldo[i] - 5000.0, "c2": 5000.0}, preenchido=True,
                       total=saldo[i], fonte="planilha")
        mensal.append(reg)
    return {
        "meta": {"titulo": "Fluxo de Caixa — Passivo Hoteleiro", "ano": 2026, "gerado_em": "01/03/2026 10:00",
                 "fontes": {"realizado": "exports", "orcado": "orc.xlsx", "saldos": "extratos"},
                 "estrutura": {"origem": "planilha"}},
        "pendentes": [],
        "meses": [{"n": i + 1, "rot": r, "status": "fechado" if i < 2 else "aberto",
                   "fonte": "export" if i < 2 else None, "arquivo": None}
                  for i, r in enumerate(["jan", "fev", "mar", "abr", "mai", "jun",
                                         "jul", "ago", "set", "out", "nov", "dez"])],
        "nat": nats,
        "estrutura": {
            "receitas": [g("Total Receitas", 0), g("Entradas", 1), n("RECEITA A", 2, REC)],
            "despesas": [g("Total Despesas", 0), g("Despesas Passivo", 1), g("Pessoal", 2),
                         n("DESPESA A", 3, DESP), n("OUTRA DESPESA", 2, OUT)],
        },
        "resumo": {
            "receitas": [{"rotulo": "Empréstimos Recebidos", "ref": {"cod": REC}}],
            "despesas": [{"rotulo": "Despesas Passivo", "ref": {"grupo": "Despesas Passivo"}},
                         {"rotulo": "Pessoal", "ref": {"grupo": "Pessoal"}}],
        },
        "orc_itens": [],
        "serie": {"receita": receita, "despesa": despesa, "variacao": variacao,
                  "orc_receita": orc_r, "orc_despesa": orc_d,
                  "orc_variacao": [orc_r[i] + orc_d[i] for i in range(12)],
                  "saldo_fim": saldo, "confronto": [0.0, 0.0] + [None] * 10},
        "saldos": {"inicial": 10000.0, "inicial_preenchido": True,
                   "contas": [{"id": "c1", "nome": "Saldo Conta Corrente"},
                              {"id": "c2", "nome": "Saldo Fundo"}],
                   "rotulo_total": "Total Contas", "rotulo_total_planilha": "Total Contas",
                   "mensal": mensal},
        "detalhe": [],
        "avisos": [],
        "qual": {"meses_fechados": 2, "exports": {}, "naturezas": 3, "sem_orc_sem_mov": 0,
                 "fora_da_planilha": [], "fora_do_bloco": [],
                 "fora_do_resumo": {"receitas": [], "despesas": []}, "lancamentos": 0},
    }


def _cadastro():
    """Cadastro sintético coerente com `_payload()`: as mesmas 3 naturezas, grupos e Resumo."""
    return {"versao": 1, "naturezas": [
        {"ordem": 10, "aba": "receitas", "cod": REC, "nome": "RECEITA A",
         "bimer": ["000001", "000009"], "path": ["Total Receitas", "Entradas"]},
        {"ordem": 20, "aba": "despesas", "cod": DESP, "nome": "DESPESA A",
         "bimer": ["000002"], "path": ["Total Despesas", "Despesas Passivo", "Pessoal"]},
        {"ordem": 30, "aba": "despesas", "cod": OUT, "nome": "OUTRA DESPESA",
         "bimer": ["000003"], "path": ["Total Despesas", "Despesas Passivo"]},
    ], "resumo": _payload()["resumo"]}


PENDENTE = {"cod": "03.2.1.02.77", "nome": "NOVA <b>NATUREZA</b>", "bimer": "001999",
            "aba": "despesas", "valor": -40.0}


class Estado:
    """O que o 'Supabase' devolve, mutável durante o teste."""
    def __init__(self, painel=True):
        self.painel = _payload() if painel else None
        self.pedidos = []           # corpos enviados à Edge Function
        self.painel_depois = None   # o que o passivo.json passa a ser depois do "Atualizar agora"
        self.cadastro = {}          # app_state 'passivo' (o cadastro de naturezas)
        self.versao = "2026-10-01T00:00:00+00:00"
        self.gravacoes = []
        self.conflito = False       # outra pessoa gravou no meio do caminho
        self.arquivos = []          # o que foi pedido ao bucket


def _abrir(caso, estado, pagina="resumo"):
    from playwright.sync_api import sync_playwright

    cls = type(caso)   # chamado com a instância; o navegador é um só para a classe
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
            if estado.painel_depois is not None:
                estado.painel = estado.painel_depois
            return route.fulfill(status=202, content_type="application/json",
                                 headers={"Access-Control-Allow-Origin": "*"},
                                 body=json.dumps({"aceito": True}))
        if "/rest/v1/app_state" in url:
            if "id=eq.passivo" not in url:
                return route.fulfill(status=403, body="documento de outro painel")
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
                                     body=json.dumps([{"id": "passivo", "updated_at": estado.versao}]))
            return route.fulfill(status=200, content_type="application/vnd.pgrst.object+json",
                                 body=json.dumps({"data": estado.cadastro, "updated_at": estado.versao}))
        if "/storage/v1/object/" in url:
            nome = url.split("?")[0].rsplit("/", 1)[-1]
            estado.arquivos.append(nome)
            doc = estado.painel if nome == "passivo.json" else None
            if doc is None:
                return route.fulfill(status=400, content_type="application/json",
                                     body=json.dumps({"statusCode": "404", "error": "not_found",
                                                      "message": "Object not found"}))
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(doc))
        return route.continue_()

    pg.route("**/*.supabase.co/**", rota)
    pg.goto((AQUI / "index.html").as_uri())
    pg.wait_for_timeout(1500)
    if pagina == "simples" and estado.painel is not None:
        pg.click("#nav-pag button:nth-child(2)")
        pg.wait_for_timeout(300)
    return pg, erros


class _ComNavegador(unittest.TestCase):
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


class TestPainelPassivo(_ComNavegador):
    def test_1_abre_com_o_dado_do_bucket(self):
        est = Estado()
        pg, erros = _abrir(self, est)
        self.assertEqual(erros, [])
        self.assertIn("2026", pg.text_content("#sub"))
        self.assertTrue(pg.is_visible("#btn-atualizar"))
        self.assertIn("01/03/2026 10:00", pg.text_content("#chip-fonte-txt"))
        self.assertIn("Publicado pelo Azure", pg.text_content(".rodape-proc"))
        self.assertEqual(est.arquivos, ["passivo.json"], "só o painel; não há card.json no Passivo")
        pg.close()

    def test_2_sem_painel_publicado_diz_o_que_houve(self):
        pg, erros = _abrir(self, Estado(painel=False))
        self.assertEqual(erros, [])
        view = pg.text_content("#view")
        self.assertIn("Painel indisponível", view)
        self.assertIn("segunda às 9h30", view)
        self.assertIn("Atualizar agora", view)
        pg.close()

    def test_3_sobe_sem_o_card_do_trello(self):
        """Decisão de 19/11/2026: o Passivo sobe sem card, como o Shiva. Sem `ligarCard` na ponte, o
        app.js não desenha o botão — nem o status dele."""
        pg, erros = _abrir(self, Estado(), pagina="simples")
        self.assertTrue(pg.is_visible("#sel-mes-simples"), "está no Resumo Simplificado")
        self.assertEqual(pg.query_selector_all("#btn-card-trello"), [])
        self.assertEqual(pg.query_selector_all("#card-status"), [])
        self.assertEqual(erros, [])
        pg.close()

    def test_4_atualizar_agora_republica_o_passivo(self):
        est = Estado()
        pg, _ = _abrir(self, est)
        pg.click("#btn-atualizar")
        pg.wait_for_timeout(1500)
        self.assertEqual(est.pedidos, [{"painel": "passivo"}])
        self.assertIn("13 minutos", pg.text_content("#reproc-status"))
        pg.close()

    def test_5_primeira_publicacao_pela_tela(self):
        """Painel NUNCA publicado: o "Atualizar agora" tem de funcionar mesmo assim — é ele
        que faz a primeira publicação (lição do Tarituba, 02/10/2026)."""
        est = Estado(painel=False)
        est.painel_depois = _payload()
        pg, erros = _abrir(self, est)
        antes = pg.text_content("#view")   # a página recarrega depois do clique
        pg.click("#btn-atualizar")
        pg.wait_for_timeout(9000)   # 5s até reler o carimbo + recarregar a página
        self.assertEqual(est.pedidos, [{"painel": "passivo"}])
        self.assertIn("Painel indisponível", antes)
        self.assertIn("2026", pg.text_content("#sub"))
        self.assertNotIn("Painel indisponível", pg.text_content("#view"))
        self.assertEqual(erros, [])
        pg.close()

    def test_6_botoes_nao_vao_para_o_pdf(self):
        pg, _ = _abrir(self, Estado())
        pg.emulate_media(media="print")
        self.assertFalse(pg.is_visible("#btn-atualizar"))
        self.assertFalse(pg.is_visible("#btn-cadastro"))
        pg.close()

    def test_7_resumo_encadeia_grupos_de_niveis_diferentes(self):
        """As sublinhas do Resumo apontam para grupos de níveis diferentes (Despesas
        Passivo > Pessoal), como na aba Resumo da planilha: cada uma soma o próprio grupo."""
        pg, erros = _abrir(self, Estado())
        linhas = pg.eval_on_selector_all(
            "table tr", "trs => trs.map(t => [...t.children].map(c => c.textContent.trim()))")
        por = {l[0]: l[1:3] for l in linhas if l}    # rótulo -> [orç jan, real jan]
        self.assertEqual(por["Despesa Total"], ["-500,00", "-500,00"])
        self.assertEqual(por["Despesas Passivo"], ["-500,00", "-500,00"])
        self.assertEqual(por["Pessoal"], ["-300,00", "-300,00"], "só a DESPESA A")
        self.assertEqual(por["Empréstimos Recebidos"], ["1.000,00", "1.100,00"])
        self.assertEqual(erros, [])
        pg.close()


class TestCadastroNaturezas(_ComNavegador):
    """"Editar cadastro de naturezas" no hub: grava naturezas E linhas do Resumo."""

    def abrir(self, pendentes=(), cadastro=True):
        est = Estado()
        est.painel["pendentes"] = list(pendentes)
        est.cadastro = _cadastro() if cadastro else {}
        pg, erros = _abrir(self, est)
        self.addCleanup(pg.close)
        self.erros, self.est = erros, est
        return pg

    def entrar(self, pg):
        pg.click("#btn-cadastro")
        pg.wait_for_selector("#pcTabNats")

    def nomes(self, pg):
        return pg.eval_on_selector_all("#pcTabNats input[data-campo='nome']",
                                       "xs => xs.map(x => x.value)")

    def test_1_botao_abre_o_cadastro_dentro_do_painel(self):
        pg = self.abrir()
        self.assertTrue(pg.is_visible("#btn-cadastro"))
        self.entrar(pg)
        self.assertEqual(self.nomes(pg), ["RECEITA A", "DESPESA A", "OUTRA DESPESA"])
        self.assertFalse(pg.is_visible("#nav-slot"), "a navegação do painel some no cadastro")
        self.assertFalse(pg.is_visible("#btn-atualizar"))
        self.assertTrue(pg.is_disabled("#pcSalvar"), "nada alterado, nada a gravar")
        banner = pg.text_content(".banner")
        self.assertIn("próxima publicação", banner, "no hub o cadastro não remonta na hora")
        self.assertNotIn("remontado na hora", banner)
        self.assertIn("publicado ainda veio da planilha", banner)
        self.assertEqual(self.erros, [])

    def test_2_gravar_leva_o_resumo_e_carimba_so_o_que_mudou(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("#pcTabNats tr:has(input[value='DESPESA A']) input[data-campo='nome']",
                "DESPESA A NOVA")
        self.assertFalse(pg.is_disabled("#pcSalvar"))
        pg.click("#pcSalvar")
        pg.wait_for_timeout(500)
        self.assertEqual(len(self.est.gravacoes), 1)
        data = self.est.gravacoes[0]["data"]
        nats = {n["cod"]: n for n in data["naturezas"]}
        self.assertEqual(nats[DESP]["nome"], "DESPESA A NOVA")
        self.assertIn("atualizado_em", nats[DESP])
        self.assertNotIn("atualizado_em", nats[REC], "carimbo só no que mudou")
        self.assertNotIn("uid", nats[DESP], "campo da tela não vai para o banco")
        self.assertEqual(data["resumo"]["despesas"][1]["ref"], {"grupo": "Pessoal"},
                         "as linhas do Resumo vão junto")
        self.assertEqual(nats[REC]["bimer"], ["000001", "000009"],
                         "o de-para (2º código do Bimer na mesma linha) vai como lista")
        st = pg.text_content("#pcStatus")
        self.assertIn("Cadastro gravado", st)
        self.assertIn("próxima publicação", st)
        self.assertEqual(self.erros, [])

    def test_3_problema_bloqueia_a_gravacao(self):
        """Mesma regra do validar() do Python: o Azure recusaria publicar."""
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("#pcTabNats tr:has(input[value='DESPESA A']) input[data-campo='bimer']", "12a")
        self.assertTrue(pg.is_visible(".erro-box"))
        self.assertIn("Bimer", pg.text_content(".erro-box"))
        self.assertTrue(pg.is_disabled("#pcSalvar"))

    def test_4_conflito_nao_sobrescreve(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("#pcTabNats tr:has(input[value='DESPESA A']) input[data-campo='nome']", "X")
        self.est.conflito = True
        pg.click("#pcSalvar")
        pg.wait_for_timeout(500)
        self.assertEqual(self.est.gravacoes, [])
        self.assertIn("outra pessoa gravou", pg.text_content("#pcStatus"))

    def test_5_cadastro_ainda_nao_semeado_nao_abre_em_branco(self):
        """Vazio, o editor abriria uma lista em branco e quem gravasse criaria o cadastro do
        zero. Diz que falta o seed e volta ao painel."""
        pg = self.abrir(cadastro=False)
        pg.click("#btn-cadastro")
        pg.wait_for_selector("#pc-voltar-erro")
        self.assertIn("ainda não foi semeado", pg.text_content("#view"))
        self.assertEqual(pg.query_selector_all("#pcTabNats"), [])
        pg.click("#pc-voltar-erro")
        pg.wait_for_timeout(300)
        self.assertTrue(pg.is_visible("#nav-slot"))
        self.assertEqual(self.erros, [])

    def test_6_aviso_de_pendentes_leva_ao_cadastro(self):
        pg = self.abrir(pendentes=[PENDENTE])
        aviso = pg.text_content("#banner-slot")
        self.assertIn("fora do cadastro", aviso)
        self.assertIn("NOVA <b>NATUREZA</b>", aviso, "o nome aparece como texto, não como HTML")
        pg.click("#btn-pend-cadastro")
        pg.wait_for_selector("#pcTabNats")
        self.assertIn("03.2.1.02.77", pg.text_content(".card.destaque"))
        self.assertEqual(pg.query_selector_all(".card.destaque b"), [], "nome da API não vira HTML")

    def test_7_voltar_ao_painel(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("#pcTabNats tr:has(input[value='DESPESA A']) input[data-campo='nome']", "X")
        pg.once("dialog", lambda d: d.dismiss())
        pg.click("#pcVoltar")
        self.assertTrue(pg.is_visible("#pcTabNats"), "cancelou: continua no cadastro")
        pg.once("dialog", lambda d: d.accept())
        pg.click("#pcVoltar")
        pg.wait_for_timeout(300)
        self.assertTrue(pg.is_visible("#nav-slot"))
        self.assertTrue(pg.is_visible("#btn-atualizar"))
        self.assertEqual(self.erros, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
