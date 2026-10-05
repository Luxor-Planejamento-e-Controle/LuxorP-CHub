"""Testa a tabela de destinos da Edge Function `reprocessar` (supabase/functions/reprocessar/rotas.js).

O que ela precisa garantir é o que falhou em 05/10/2026: um par de secrets compartilhado
apontado para a rota da inadimplência derrubou o "Atualizar agora" de todos os outros
painéis, e a inadimplência seguia funcionando — nada parecia quebrado. Agora cada destino
tem o próprio par, e secret na rota errada vira erro que nomeia o secret.

Roda o rotas.js de verdade no Chromium (é JavaScript puro, sem Deno), sem rede e sem
Supabase. Fica em assets/ porque é aí que o CI procura test_*.py.

Uso: python assets/test_rotas_reprocessar.py   (da raiz do repo do hub)
"""

import json
import pathlib
import re
import unittest

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ROTAS_JS = RAIZ / "supabase" / "functions" / "reprocessar" / "rotas.js"

APP = "https://luxor-planejamento-pipelines-functions.azurewebsites.net"
CERTO = {
    "AZURE_AUTOMACOES_URL": f"{APP}/api/reprocessar",
    "AZURE_AUTOMACOES_KEY": "chave-automacoes",
    "AZURE_INADIMPLENCIA_URL": f"{APP}/api/pc/inadimplencia",
    "AZURE_INADIMPLENCIA_KEY": "chave-inadimplencia",
}


class TestRotas(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest("playwright não instalado")
        cls._pw = sync_playwright().start()
        cls._b = cls._pw.chromium.launch()
        cls.pg = cls._b.new_page()
        # módulo ES -> script comum: o Chromium não importa módulo de file://
        codigo = re.sub(r"^export\s+", "", ROTAS_JS.read_text(encoding="utf-8"), flags=re.M)
        cls.pg.add_script_tag(content=codigo + "\nwindow.__ROTAS = ROTAS; window.__destino = destino;")

    @classmethod
    def tearDownClass(cls):
        cls._b.close()
        cls._pw.stop()

    def destino(self, painel, env):
        return self.pg.evaluate(
            "([p, env]) => window.__destino(p, n => env[n])", [painel, env])

    def test_1_cada_painel_vai_para_o_seu_destino(self):
        for painel in ("saldo_bancario", "controle_pagamentos", "tarituba"):
            self.assertEqual(self.destino(painel, CERTO),
                             {"url": f"{APP}/api/reprocessar", "chave": "chave-automacoes"}, painel)
        self.assertEqual(self.destino("inadimplencia", CERTO),
                         {"url": f"{APP}/api/pc/inadimplencia", "chave": "chave-inadimplencia"})

    def test_2_o_erro_de_05_10_vira_mensagem_que_nomeia_o_secret(self):
        """O secret dos painéis do Automacoes apontando para a rota da inadimplência — o
        estado de 05/10. Antes virava 'Azure recusou (400): painel desconhecido'."""
        env = dict(CERTO, AZURE_AUTOMACOES_URL=f"{APP}/api/pc/inadimplencia")
        r = self.destino("tarituba", env)
        self.assertEqual(r["status"], 500)
        self.assertIn("AZURE_AUTOMACOES_URL", r["erro"])
        self.assertIn("/api/reprocessar", r["erro"])

    def test_3_um_destino_nao_depende_do_outro(self):
        """Sem os secrets de um lado, o outro continua de pé — é o isolamento que faltava."""
        so_inad = {k: v for k, v in CERTO.items() if "INADIMPLENCIA" in k}
        so_auto = {k: v for k, v in CERTO.items() if "AUTOMACOES" in k}
        self.assertIn("url", self.destino("inadimplencia", so_inad))
        self.assertIn("url", self.destino("tarituba", so_auto))
        self.assertIn("AZURE_AUTOMACOES_URL/AZURE_AUTOMACOES_KEY não configurados",
                      self.destino("tarituba", so_inad)["erro"])
        self.assertIn("AZURE_INADIMPLENCIA_URL/AZURE_INADIMPLENCIA_KEY não configurados",
                      self.destino("inadimplencia", so_auto)["erro"])

    def test_4_os_nomes_antigos_nao_valem_mais(self):
        """Sem fallback para AZURE_REPROCESSAR_*: um fallback esconderia exatamente o par
        compartilhado que causou o problema."""
        antigo = {"AZURE_REPROCESSAR_URL": f"{APP}/api/reprocessar", "AZURE_REPROCESSAR_KEY": "x"}
        for painel in ("tarituba", "inadimplencia"):
            self.assertEqual(self.destino(painel, antigo)["status"], 500, painel)

    def test_5_painel_fora_da_tabela(self):
        for ruim in ("projetos", "", "constructor", "__proto__", "toString"):
            r = self.destino(ruim, CERTO)
            self.assertEqual(r.get("status"), 400, ruim)

    def test_6_barra_no_fim_e_espaco_nao_atrapalham(self):
        env = dict(CERTO, AZURE_AUTOMACOES_URL=f" {APP}/api/reprocessar/ ")
        self.assertIn("url", self.destino("saldo_bancario", env))

    def test_7_url_invalida(self):
        r = self.destino("tarituba", dict(CERTO, AZURE_AUTOMACOES_URL="api/reprocessar"))
        self.assertEqual(r["status"], 500)
        self.assertIn("não é uma URL válida", r["erro"])

    def test_8_todo_botao_do_hub_tem_destino(self):
        """Painel que liga o botão (`painel: '<id>'`) sem estar na tabela clicaria e
        receberia 400. Procura nos painéis e no gerador da inadimplência, cujo HTML
        sai do tools/ e não fica no repo."""
        ids = set()
        for pasta in ("assets", "tools"):
            for f in (RAIZ / pasta).rglob("*"):
                if f.suffix in (".js", ".html", ".py") and not f.name.startswith("test_"):
                    ids |= set(re.findall(r"painel:\s*'([a-z_]+)'",
                                          f.read_text(encoding="utf-8", errors="ignore")))
        self.assertTrue({"saldo_bancario", "controle_pagamentos", "tarituba", "inadimplencia"} <= ids,
                        ids)
        rotas = set(self.pg.evaluate("Object.keys(window.__ROTAS)"))
        self.assertEqual(ids - rotas, set(), "botão sem destino na tabela")


if __name__ == "__main__":
    unittest.main(verbosity=2)
