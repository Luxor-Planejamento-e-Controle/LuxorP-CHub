"""Testa o painel do Tarituba no hub com o supabase-js REAL e a rede interceptada.

Mesma abordagem dos outros fluxos (assets/tarituba/test_painel.py, de onde este foi copiado em
11/2026): nada de credencial, sessão ou Supabase de verdade — as requisições do supabase-js
são atendidas aqui, o que também confere que o painel pede o arquivo, a função e os
documentos certos.

Desde 11/2026 o Tarituba é como a Tarituba: SEM o card do Trello, o cadastro grava naturezas e
linhas do Resumo, e as MOVIMENTAÇÕES MANUAIS (app_state 'tarituba_manuais') têm o carimbo
(id, ano, quem, quando) posto pela ponte a partir do que está gravado. Próprio daqui: o
cadastro gravado em 16/10/2026 não tem `resumo` nem `bimer` em lista — o editor abre com as
linhas do painel publicado e gravar as guarda. O payload é SINTÉTICO (nomes e valores
inventados): o repositório é público.

Uso: python assets/tarituba/test_painel.py   (da raiz do repo do hub)
"""

import json
import pathlib
import unittest
import urllib.parse

AQUI = pathlib.Path(__file__).resolve().parent

REC, DESP, OUT = "13.1.1.01.01", "13.2.1.01.01", "13.2.1.01.99"
EMAIL = "fulano@exemplo.com"


def _payload():
    """Forma real do que o Azure publica (extrair_tarituba.montar), com dado inventado."""
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
        "meta": {"titulo": "Fluxo de Caixa — Tarituba", "ano": 2026, "gerado_em": "01/03/2026 10:00",
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
            "despesas": [g("Total Despesas", 0), g("Despesas Tarituba", 1), g("Pessoal", 2),
                         n("DESPESA A", 3, DESP), n("OUTRA DESPESA", 2, OUT)],
        },
        "resumo": {
            "receitas": [{"rotulo": "Aportes", "ref": {"cod": REC}}],
            "despesas": [{"rotulo": "Despesas Tarituba", "ref": {"grupo": "Despesas Tarituba"}},
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
        "manuais": {"movimentos": []},
        "qual": {"meses_fechados": 2, "exports": {}, "naturezas": 3, "sem_orc_sem_mov": 0,
                 "fora_da_planilha": [], "fora_do_bloco": [],
                 "fora_do_resumo": {"receitas": [], "despesas": []}, "lancamentos": 0},
    }


def _cadastro():
    """Cadastro sintético coerente com `_payload()`: as mesmas 3 naturezas, grupos e Resumo."""
    return {"versao": 1, "naturezas": [
        {"ordem": 10, "aba": "receitas", "cod": REC, "nome": "RECEITA A",
         "bimer": ["000001"], "path": ["Total Receitas", "Entradas"]},
        {"ordem": 20, "aba": "despesas", "cod": DESP, "nome": "DESPESA A",
         "bimer": ["000002"], "path": ["Total Despesas", "Despesas Tarituba", "Pessoal"]},
        {"ordem": 30, "aba": "despesas", "cod": OUT, "nome": "OUTRA DESPESA",
         "bimer": ["000003"], "path": ["Total Despesas", "Despesas Tarituba"]},
    ], "resumo": _payload()["resumo"]}


# já gravada antes; e uma de OUTRO ano, que a tela não mostra mas não pode perder
MOV_1 = {"id": 1, "ano": 2026, "tipo": "avulsa", "mes": 1, "cod": DESP, "valor": -10.0,
         "motivo": "ajuste antigo", "criado_em": "2026-02-01T09:00:00", "criado_por": "quem lançou"}
MOV_VELHA = {"id": 7, "ano": 2025, "tipo": "avulsa", "mes": 12, "cod": DESP, "valor": -5.0,
             "motivo": "de outro ano", "criado_em": "2025-12-30T09:00:00", "criado_por": "outra"}

PENDENTE = {"cod": "13.2.1.01.77", "nome": "NOVA <b>NATUREZA</b>", "bimer": "001999",
            "aba": "despesas", "valor": -40.0}


class Estado:
    """O que o 'Supabase' devolve, mutável durante o teste."""
    def __init__(self, painel=True):
        self.painel = _payload() if painel else None
        self.pedidos = []           # corpos enviados à Edge Function
        self.painel_depois = None   # o que o tarituba.json passa a ser depois do "Atualizar agora"
        # app_state: id -> {data, updated_at}
        self.docs = {"tarituba": {"data": {}, "updated_at": "2026-10-01T00:00:00+00:00"},
                     "tt_manuais": {"data": {}, "updated_at": "2026-10-02T00:00:00+00:00"}}
        self.gravacoes = []         # (id, corpo)
        self.conflito = False       # outra pessoa gravou no meio do caminho
        self.arquivos = []          # o que foi pedido ao bucket
        self.lidos = []             # ids de app_state pedidos


def _id_pedido(url):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    v = (q.get("id") or [""])[0]
    return v[3:] if v.startswith("eq.") else None


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
        if "/auth/v1/" in url:
            # sessão: só o e-mail interessa (é ele que carimba as movimentações)
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"id": "u1", "email": EMAIL}))
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
            doc_id = _id_pedido(url)
            if doc_id not in estado.docs:
                return route.fulfill(status=403, body="documento de outro painel")
            doc = estado.docs[doc_id]
            if request.method in ("PATCH", "POST"):
                # guarda de concorrência: o UPDATE leva `updated_at=eq.<versão lida>`; versão
                # vencida não casa linha nenhuma e o PostgREST devolve lista vazia
                q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                pedida = (q.get("updated_at") or [None])[0]
                pedida = pedida[3:] if pedida and pedida.startswith("eq.") else None
                if estado.conflito or (pedida is not None and pedida != doc["updated_at"]):
                    return route.fulfill(status=200, content_type="application/json", body="[]")
                corpo = json.loads(request.post_data)
                estado.gravacoes.append((doc_id, corpo))
                doc["data"] = corpo["data"]
                doc["updated_at"] = corpo.get("updated_at") or doc["updated_at"]
                return route.fulfill(status=200, content_type="application/json",
                                     body=json.dumps([{"id": doc_id, "updated_at": doc["updated_at"]}]))
            estado.lidos.append(doc_id)
            return route.fulfill(status=200, content_type="application/vnd.pgrst.object+json",
                                 body=json.dumps({"data": doc["data"], "updated_at": doc["updated_at"]}))
        if "/storage/v1/object/" in url:
            nome = url.split("?")[0].rsplit("/", 1)[-1]
            estado.arquivos.append(nome)
            doc = estado.painel if nome == "tarituba.json" else None
            if doc is None:
                return route.fulfill(status=400, content_type="application/json",
                                     body=json.dumps({"statusCode": "404", "error": "not_found",
                                                      "message": "Object not found"}))
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(doc))
        return route.continue_()

    pg.route("**/*.supabase.co/**", rota)
    # sessão "logada": o supabase-js lê do localStorage antes de pedir o e-mail
    pg.add_init_script("""(() => {
      const k = 'sb-hjducsxcolbspbkpflom-auth-token';
      const exp = Math.floor(Date.now() / 1000) + 3600;
      localStorage.setItem(k, JSON.stringify({access_token: 'x', refresh_token: 'y',
        token_type: 'bearer', expires_in: 3600, expires_at: exp,
        user: {id: 'u1', email: '%s'}}));
    })();""" % EMAIL)
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


class TestPainelTarituba(_ComNavegador):
    def test_1_abre_com_o_dado_do_bucket(self):
        est = Estado()
        pg, erros = _abrir(self, est)
        self.assertEqual(erros, [])
        self.assertIn("2026", pg.text_content("#sub"))
        self.assertTrue(pg.is_visible("#btn-atualizar"))
        self.assertTrue(pg.is_visible("#btn-cadastro"))
        self.assertTrue(pg.is_visible("#btn-manuais"))
        self.assertIn("01/03/2026 10:00", pg.text_content("#chip-fonte-txt"))
        self.assertIn("Publicado pelo Azure", pg.text_content(".rodape-proc"))
        self.assertEqual(est.arquivos, ["tarituba.json"], "só o painel; não há mais card.json")
        self.assertEqual(est.lidos, [], "cadastro e movimentações só são lidos ao abrir a tela")
        pg.close()

    def test_2_sem_painel_publicado_diz_o_que_houve(self):
        pg, erros = _abrir(self, Estado(painel=False))
        self.assertEqual(erros, [])
        view = pg.text_content("#view")
        self.assertIn("Painel indisponível", view)
        self.assertIn("segunda às 9h", view)
        self.assertIn("Atualizar agora", view)
        pg.close()

    def test_3_sobe_sem_o_card_do_trello(self):
        """Decisão de 24/11/2026: o Tarituba fica sem card, como os outros fluxos. Sem
        `ligarCard` na ponte, o app.js não desenha o botão — nem o status dele."""
        pg, erros = _abrir(self, Estado(), pagina="simples")
        self.assertTrue(pg.is_visible("#sel-mes-simples"), "está no Resumo Simplificado")
        self.assertEqual(pg.query_selector_all("#btn-card-trello"), [])
        self.assertEqual(pg.query_selector_all("#card-status"), [])
        self.assertEqual(erros, [])
        pg.close()

    def test_4_atualizar_agora_republica_a_tarituba(self):
        est = Estado()
        pg, _ = _abrir(self, est)
        pg.click("#btn-atualizar")
        pg.wait_for_timeout(1500)
        self.assertEqual(est.pedidos, [{"painel": "tarituba"}])
        self.assertIn("11 minutos", pg.text_content("#reproc-status"))
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
        self.assertEqual(est.pedidos, [{"painel": "tarituba"}])
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
        self.assertFalse(pg.is_visible("#btn-manuais"))
        pg.close()

    def test_7_resumo_encadeia_grupos_de_niveis_diferentes(self):
        pg, erros = _abrir(self, Estado())
        linhas = pg.eval_on_selector_all(
            "table tr", "trs => trs.map(t => [...t.children].map(c => c.textContent.trim()))")
        por = {l[0]: l[1:3] for l in linhas if l}    # rótulo -> [orç jan, real jan]
        self.assertEqual(por["Despesas Tarituba"], ["-500,00", "-500,00"])
        self.assertEqual(por["Pessoal"], ["-300,00", "-300,00"], "só a DESPESA A")
        self.assertEqual(por["Aportes"], ["1.000,00", "1.100,00"])
        self.assertEqual(erros, [])
        pg.close()


class TestCadastroNaturezas(_ComNavegador):
    """"Editar cadastro de naturezas" no hub: grava naturezas E linhas do Resumo."""

    def abrir(self, pendentes=(), cadastro=True):
        est = Estado()
        est.painel["pendentes"] = list(pendentes)
        est.docs["tarituba"]["data"] = _cadastro() if cadastro else {}
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
        self.entrar(pg)
        self.assertEqual(self.nomes(pg), ["RECEITA A", "DESPESA A", "OUTRA DESPESA"])
        self.assertEqual(self.est.lidos, ["tarituba"])
        self.assertFalse(pg.is_visible("#nav-slot"), "a navegação do painel some no cadastro")
        self.assertFalse(pg.is_visible("#btn-atualizar"))
        self.assertFalse(pg.is_visible("#btn-manuais"))
        self.assertTrue(pg.is_disabled("#pcSalvar"), "nada alterado, nada a gravar")
        banner = pg.text_content(".banner")
        self.assertIn("próxima publicação", banner, "no hub o cadastro não remonta na hora")
        self.assertNotIn("remontado na hora", banner)
        self.assertEqual(self.erros, [])

    def test_2_gravar_leva_o_resumo_e_carimba_so_o_que_mudou(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("#pcTabNats tr:has(input[value='DESPESA A']) input[data-campo='nome']",
                "DESPESA A NOVA")
        pg.click("#pcSalvar")
        pg.wait_for_timeout(500)
        self.assertEqual([g[0] for g in self.est.gravacoes], ["tarituba"])
        data = self.est.gravacoes[0][1]["data"]
        nats = {n["cod"]: n for n in data["naturezas"]}
        self.assertEqual(nats[DESP]["nome"], "DESPESA A NOVA")
        self.assertEqual(nats[DESP]["atualizado_por"], EMAIL)
        self.assertNotIn("atualizado_em", nats[REC], "carimbo só no que mudou")
        self.assertNotIn("uid", nats[DESP], "campo da tela não vai para o banco")
        self.assertEqual(data["resumo"]["despesas"][1]["ref"], {"grupo": "Pessoal"},
                         "as linhas do Resumo vão junto")
        self.assertIn("Cadastro gravado", pg.text_content("#pcStatus"))
        self.assertEqual(self.erros, [])

    def test_2b_cadastro_de_16_10_sem_resumo_grava_o_do_painel(self):
        """O documento gravado em 16/10/2026 não tem `resumo` (e tem `bimer` em texto): o
        editor abre com as linhas do painel publicado, e gravar as guarda — sem isso, a
        primeira gravação apagaria as sublinhas do Resumo."""
        pg = self.abrir()
        antigo = _cadastro()
        del antigo["resumo"]
        for n in antigo["naturezas"]:
            n["bimer"] = n["bimer"][0]
        self.est.docs["tarituba"]["data"] = antigo
        self.entrar(pg)
        pg.fill("#pcTabNats tr:has(input[value='DESPESA A']) input[data-campo='nome']",
                "DESPESA A NOVA")
        pg.click("#pcSalvar")
        pg.wait_for_timeout(500)
        data = self.est.gravacoes[0][1]["data"]
        self.assertEqual(data["resumo"], _payload()["resumo"], "as linhas do painel publicado")
        self.assertEqual({n["cod"]: n["bimer"] for n in data["naturezas"]},
                         {REC: ["000001"], DESP: ["000002"], OUT: ["000003"]}, "bimer em lista")
        self.assertEqual(self.erros, [])

    def test_3_conflito_nao_sobrescreve(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.fill("#pcTabNats tr:has(input[value='DESPESA A']) input[data-campo='nome']", "X")
        self.est.conflito = True
        pg.click("#pcSalvar")
        pg.wait_for_timeout(500)
        self.assertEqual(self.est.gravacoes, [])
        self.assertIn("outra pessoa gravou", pg.text_content("#pcStatus"))

    def test_4_cadastro_ainda_nao_semeado_nao_abre_em_branco(self):
        pg = self.abrir(cadastro=False)
        pg.click("#btn-cadastro")
        pg.wait_for_selector("#tarituba-voltar-erro")
        self.assertIn("ainda não foi semeado", pg.text_content("#view"))
        self.assertEqual(pg.query_selector_all("#pcTabNats"), [])
        pg.click("#tarituba-voltar-erro")
        pg.wait_for_timeout(300)
        self.assertTrue(pg.is_visible("#nav-slot"))
        self.assertTrue(pg.is_visible("#btn-manuais"))
        self.assertEqual(self.erros, [])

    def test_5_aviso_de_pendentes_leva_ao_cadastro(self):
        pg = self.abrir(pendentes=[PENDENTE])
        aviso = pg.text_content("#banner-slot")
        self.assertIn("fora do cadastro", aviso)
        self.assertIn("NOVA <b>NATUREZA</b>", aviso, "o nome aparece como texto, não como HTML")
        pg.click("#btn-pend-cadastro")
        pg.wait_for_selector("#pcTabNats")
        self.assertIn("13.2.1.01.77", pg.text_content(".card.destaque"))

    def test_6_nova_natureza_do_ramo_13_entra(self):
        """O formulário herdou do Passivo a regra /^03\\./ e recusava toda natureza do Tarituba
        (apontado pelo Arthur no #31; o mesmo do #32 na FPG e do #33 no Shiva)."""
        pg = self.abrir(pendentes=[PENDENTE])
        self.entrar(pg)
        pg.click("[data-pa='0']")              # a pendente abre o formulário já preenchido
        pg.wait_for_selector("#pcForm")
        self.assertEqual(pg.input_value("#pcFCod"), "13.2.1.01.77")
        pg.select_option("#pcFGrupo", index=1)
        pg.dispatch_event("#pcFGrupo", "input")
        self.assertEqual(pg.text_content("[data-erro='cod']"), "")
        self.assertFalse(pg.is_disabled("#pcFAdd"))
        for outro in ("03.2.1.01.77", "11.2.1.01.77", "13.2.1.01.77x"):
            pg.fill("#pcFCod", outro)
            self.assertIn("Fora do formato 13.", pg.text_content("[data-erro='cod']"), outro)
            self.assertTrue(pg.is_disabled("#pcFAdd"), outro)
        pg.fill("#pcFCod", "13.2.1.01.77")
        pg.click("#pcFAdd")
        pg.click("#pcSalvar")
        pg.wait_for_timeout(500)
        nats = {n["cod"]: n for n in self.est.gravacoes[0][1]["data"]["naturezas"]}
        self.assertEqual(nats["13.2.1.01.77"]["bimer"], ["001999"])
        self.assertEqual(nats["13.2.1.01.77"]["atualizado_por"], EMAIL)
        self.assertEqual(self.erros, [])


class TestMovimentacoesManuais(_ComNavegador):
    """"Movimentações" no hub: app_state 'tt_manuais', com o carimbo posto pela ponte."""

    def abrir(self, movimentos=(MOV_1, MOV_VELHA)):
        est = Estado()
        est.docs["tt_manuais"]["data"] = {"versao": 1, "movimentos": [dict(m) for m in movimentos]}
        pg, erros = _abrir(self, est)
        pg.on("dialog", lambda d: d.accept())
        self.addCleanup(pg.close)
        self.erros, self.est = erros, est
        return pg

    def entrar(self, pg):
        pg.click("#btn-manuais")
        pg.wait_for_selector("#mnAdicionar")

    def lancar_reclassificacao(self, pg):
        pg.click('[data-tipo="reclassificacao"]')
        pg.select_option("#mnMes", "2")
        pg.select_option("#mnDe", DESP)
        pg.select_option("#mnPara", OUT)
        pg.fill("#mnValor", "−50,00")
        pg.fill("#mnMotivo", "teste pela tela")
        pg.wait_for_timeout(150)
        pg.click("#mnAdicionar")

    def test_1_abre_so_com_as_do_ano(self):
        pg = self.abrir()
        self.entrar(pg)
        view = pg.inner_text("#view")
        self.assertEqual(self.est.lidos, ["tt_manuais"])
        self.assertIn("Lançadas em 2026 (1)", view, "a de 2025 fica no documento, fora da lista")
        self.assertIn("ajuste antigo", view)
        self.assertIn("próxima", view, "no hub a movimentação vale na próxima publicação")
        self.assertFalse(pg.is_visible("#btn-cadastro"))
        self.assertFalse(pg.is_visible("#btn-atualizar"))
        meses = pg.eval_on_selector_all("#mnMes option", "os => os.map(o => o.value)")
        self.assertEqual(meses, ["", "1", "2"], "só meses com realizado")
        self.assertEqual(self.erros, [])

    def test_2_lancar_carimba_e_nao_perde_a_de_outro_ano(self):
        pg = self.abrir()
        self.entrar(pg)
        self.lancar_reclassificacao(pg)
        pg.wait_for_function("() => /Lançadas em 2026 \\(2\\)/.test(document.getElementById('view').innerText)",
                             timeout=10000)
        self.assertEqual([g[0] for g in self.est.gravacoes], ["tt_manuais"])
        movs = self.est.gravacoes[0][1]["data"]["movimentos"]
        por = {m["id"]: m for m in movs}
        self.assertEqual(sorted(por), [1, 7, 8], "id novo = maior gravado + 1; a de 2025 continua")
        novo = por[8]
        self.assertEqual((novo["tipo"], novo["mes"], novo["de"], novo["para"], novo["valor"]),
                         ("reclassificacao", 2, DESP, OUT, -50.0))
        self.assertEqual((novo["ano"], novo["criado_por"]), (2026, EMAIL))
        self.assertRegex(novo["criado_em"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")
        self.assertEqual(por[1], MOV_1, "a que já existia segue intacta, sem carimbo novo")
        self.assertEqual(por[7], MOV_VELHA)
        self.assertIn("próxima publicação", pg.inner_text("#mnStatus"))
        self.assertEqual(self.erros, [])

    def test_3_carimbo_vem_do_gravado_nao_da_tela(self):
        """A tela manda a lista inteira; quem lançou e quando vêm do documento gravado,
        mesmo que a página tenha sido adulterada."""
        r = None
        pg = self.abrir()
        self.entrar(pg)
        r = pg.evaluate("""() => TARITUBA_HUB._carimbar(
            [{id: 1, tipo: 'avulsa', mes: 1, cod: '%s', valor: -10, motivo: 'ajuste antigo',
              criado_por: 'forjado', criado_em: '2000-01-01T00:00:00'},
             {id: 99, tipo: 'avulsa', mes: 2, cod: '%s', valor: -1, motivo: ' novo '}],
            [%s], 'eu', '2026-03-01T10:00:00', 2026)""" % (DESP, DESP, json.dumps(MOV_1)))
        self.assertEqual(r[0]["criado_por"], "quem lançou")
        self.assertNotIn("atualizado_em", r[0], "não mudou nada")
        self.assertEqual((r[1]["id"], r[1]["criado_por"], r[1]["motivo"]), (2, "eu", "novo"),
                         "id inventado pela tela não vale: é o próximo do gravado")

    def test_4_excluir_grava_a_lista_sem_ela(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.click('[data-excluir="1"]')
        pg.wait_for_function("() => /Lançadas em 2026 \\(0\\)/.test(document.getElementById('view').innerText)",
                             timeout=10000)
        movs = self.est.gravacoes[0][1]["data"]["movimentos"]
        self.assertEqual([m["id"] for m in movs], [7], "só a de outro ano sobra")
        self.assertEqual(self.erros, [])

    def test_5_conflito_nao_sobrescreve(self):
        pg = self.abrir()
        self.entrar(pg)
        self.est.conflito = True
        self.lancar_reclassificacao(pg)
        pg.wait_for_selector(".erro-box")
        self.assertEqual(self.est.gravacoes, [])
        self.assertIn("outra pessoa gravou", pg.inner_text(".erro-box"))
        self.assertIn("Lançadas em 2026 (1)", pg.inner_text("#view"))

    def test_6_documento_ausente_diz_que_falta_o_sql(self):
        pg = self.abrir()
        del self.est.docs["tt_manuais"]
        pg.click("#btn-manuais")
        pg.wait_for_selector("#tarituba-voltar-erro")
        self.assertIn("Movimentações indisponíveis", pg.inner_text("#view"))
        pg.click("#tarituba-voltar-erro")
        pg.wait_for_timeout(300)
        self.assertTrue(pg.is_visible("#btn-manuais"))

    def test_7_voltar_ao_painel(self):
        pg = self.abrir()
        self.entrar(pg)
        pg.click("#mnVoltar")
        pg.wait_for_timeout(300)
        self.assertTrue(pg.is_visible("#nav-slot"))
        self.assertTrue(pg.is_visible("#btn-atualizar"))
        self.assertEqual(self.erros, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
