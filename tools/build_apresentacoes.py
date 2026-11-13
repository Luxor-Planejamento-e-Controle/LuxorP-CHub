"""Decks do Comitê de Resultados (FO) e do Board, que saíram do Power BI.

Os dois relatórios (`Comitê_FO.pbip` e `Board_FO.pbip`) só liam planilhas que o
fechamento do FO já grava em `LuxorControlDatabase/` no Blob e faziam a conta
final em DAX. Este script lê AS MESMAS planilhas e refaz SÓ essa conta final —
cada função `s_*` diz de qual medida do PBI veio. Nada de ETL novo: se um número
estiver errado, o lugar de corrigir é a rotina que gera a planilha.

Saída: um JSON por deck (`assets/data/<deck>.json`), com um conjunto de slides
por TRIMESTRE. O desenho fica no navegador (`assets/apresentacoes/`), que vira
tela, PDF e PPTX a partir do mesmo JSON.

Trimestre fechado não muda: por padrão o script gera só o trimestre mais
recente com dado e mescla com o JSON já publicado no bucket, mantendo os
anteriores como foram apresentados. Refazer um trimestre antigo é explícito.

Uso:
    python tools/build_apresentacoes.py                 # os dois decks, trimestre corrente
    python tools/build_apresentacoes.py board_fo        # só um deck
    python tools/build_apresentacoes.py --tri 2026-Q2 --refazer
    python tools/build_apresentacoes.py --desde 2026-Q1 # carga inicial (refaz todos desde)
    python tools/build_apresentacoes.py --bases DIR     # lê os arquivos de uma pasta local
    python tools/build_apresentacoes.py --sem-publicado # não baixa o publicado (teste)

Requer: pandas, openpyxl, pyarrow, azure-storage-blob (conn do Blob como no
build_data.py) e, para mesclar com o publicado, SUPABASE_URL +
SUPABASE_SERVICE_ROLE_KEY (como no publish_hub.py).
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "data"
CONTAINER = "luxor-planejamento-e-controle"
PREFIXO = "LuxorControlDatabase/"
BUCKET = "hub-data"

DECKS = ("comite_fo", "board_fo", "carta")
TITULO_DECK = {"comite_fo": "Comitê de Resultados FO", "board_fo": "Board", "carta": "Carta Trimestral"}

# --------------------------------------------------------------------------
# cores do relatório (as do PBI)
# --------------------------------------------------------------------------
LARANJA, VERMELHO, CINZA_KR, TEAL = "FFA400", "FF0000", "D9D9D9", "1D6E79"
AMARELO_CARD, CINZA_CARD = "FFC000", "7C7C7C"

MESES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MESES_PT_EN = {"Jan": "Jan", "Fev": "Feb", "Mar": "Mar", "Abr": "Apr", "Mai": "May",
               "Jun": "Jun", "Jul": "Jul", "Ago": "Aug", "Set": "Sep", "Out": "Oct",
               "Nov": "Nov", "Dez": "Dec"}


def nfc(s):
    return unicodedata.normalize("NFC", str(s)) if s is not None else s


def chave(s):
    """Comparação sem acento e sem caixa — o DAX compara texto sem caixa, e os
    nomes de segmento já mudaram de grafia antes."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(s))
                   if not unicodedata.combining(c)).strip().lower()


def num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if pd.isna(f) else f


# --------------------------------------------------------------------------
# períodos
# --------------------------------------------------------------------------
def tri_de(d: pd.Timestamp) -> str:
    return f"{d.year}-Q{(d.month - 1) // 3 + 1}"


def fim_tri(tri: str) -> pd.Timestamp:
    m = re.fullmatch(r"(\d{4})-Q([1-4])", tri.strip().upper())
    if not m:
        sys.exit(f"Trimestre inválido: {tri!r} (use AAAA-QN, ex. 2026-Q3)")
    a, q = int(m.group(1)), int(m.group(2))
    return pd.Timestamp(a, q * 3, 1) + pd.offsets.MonthEnd(0)


def rot_q(d):          # "2026 Q3"
    return f"{d.year} Q{(d.month - 1) // 3 + 1}"


def rot_ytd(d):        # "2026 YTD"
    return f"{d.year} YTD"


def aum_q(d):          # "AUM Q3 2026"
    return f"AUM Q{(d.month - 1) // 3 + 1} {d.year}"


def aum_q_anterior(d):  # "AUM Q2 2026" — EDATE(_date, -3)
    return aum_q(d - pd.DateOffset(months=3) + pd.offsets.MonthEnd(0))


def aum_ano_anterior(d):  # "AUM Q4 2025"
    return f"AUM Q4 {d.year - 1}"


# --------------------------------------------------------------------------
# bases
# --------------------------------------------------------------------------
class Bases:
    """Lê as planilhas que o PBI lia. Do Blob por padrão; de uma pasta local com
    `--bases` (mesmos nomes de arquivo, sem a pasta excel/ ou parquet/)."""

    def __init__(self, pasta: Path | None = None):
        self.pasta = pasta
        self._bsc = None
        self._cache: dict = {}
        self.fontes: dict = {}
        self.imagens: dict = {}

    def _bytes(self, rel: str) -> bytes:
        if self.pasta:
            p = self.pasta / rel.split("/")[-1]
            self.fontes[rel] = {"arquivo": p.name,
                                "modificado": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="minutes")}
            return p.read_bytes()
        if self._bsc is None:
            self._bsc = blob_cliente()
        bc = self._bsc.get_blob_client(CONTAINER, PREFIXO + rel)
        dl = bc.download_blob()
        self.fontes[rel] = {"arquivo": rel.split("/")[-1],
                            "modificado": dl.properties.last_modified.isoformat(timespec="minutes")}
        return dl.readall()

    def excel(self, rel: str, aba=0) -> pd.DataFrame:
        k = (rel, aba)
        if k not in self._cache:
            df = pd.read_excel(io.BytesIO(self._bytes(rel)), sheet_name=aba)
            df.columns = [nfc(c) for c in df.columns]
            for c in df.columns:
                if df[c].dtype == object:
                    df[c] = df[c].map(lambda v: nfc(v) if isinstance(v, str) else v)
            self._cache[k] = df
        return self._cache[k]

    def parquet(self, rel: str) -> pd.DataFrame:
        if rel not in self._cache:
            df = pd.read_parquet(io.BytesIO(self._bytes(rel)))
            for c in df.columns:
                if df[c].dtype == object:
                    df[c] = df[c].map(lambda v: nfc(v) if isinstance(v, str) else v)
            self._cache[rel] = df
        return self._cache[rel]

    def binario(self, rel: str) -> bytes | None:
        try:
            return self._bytes(rel)
        except Exception:
            return None

    # tabelas do modelo, com o nome do PBI
    @property
    def dados(self):
        df = self.excel("excel/group_hist_data.xlsx")
        df["Date"] = pd.to_datetime(df["Date"])
        df["_seg"] = df["Segment"].map(chave)
        return df

    @property
    def indices(self):
        df = self.excel("excel/Indicadores_financeiros.xlsx")
        df = df.rename(columns={df.columns[1]: "Indice", df.columns[2]: "Data"})
        df["Data"] = pd.to_datetime(df["Data"])
        df["_ind"] = df["Indice"].map(chave)
        return df


def azure_conn():
    """Mesma regra do build_data.py: ambiente primeiro, .env do FinancialIndicators depois.
    None quando não há nenhum dos dois (na Azure, onde vale a identidade do app)."""
    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if conn:
        return conn
    env = Path(r"C:/Users/Arthur/repos/FinancialIndicators/.env")
    if env.exists():
        from dotenv import dotenv_values
        conn = dotenv_values(env).get("AZURE_STORAGE_CONNECTION_STRING")
    return conn or None


def blob_cliente():
    """Na máquina, a connection string; no Function App (botão "Atualizar agora"), a
    identidade gerenciada do app, que tem leitura no container — sem chave nenhuma."""
    from azure.storage.blob import BlobServiceClient
    conn = azure_conn()
    if conn:
        return BlobServiceClient.from_connection_string(conn)
    if not os.environ.get("WEBSITE_INSTANCE_ID"):
        sys.exit("Falta AZURE_STORAGE_CONNECTION_STRING (ambiente ou .env do FinancialIndicators).")
    from azure.identity import ManagedIdentityCredential
    return BlobServiceClient("https://azblobstoragebz.blob.core.windows.net",
                             credential=ManagedIdentityCredential())


class SemDado(Exception):
    """A base não tem o período pedido — o slide sai como pendente."""


# --------------------------------------------------------------------------
# medidas (as do modelo Dados/IndicesFin)
# --------------------------------------------------------------------------
class Medidas:
    def __init__(self, b: Bases, d: pd.Timestamp):
        self.b, self.d = b, d
        g = b.dados
        self.gd = g[g.Date == d]
        if self.gd.empty:
            raise SemDado(f"group_hist_data sem {d:%d/%m/%Y}")
        i = b.indices
        self.ind = i[i.Data == d]

    def seg(self, segmento, col, agg="sum"):
        x = self.gd[self.gd._seg == chave(segmento)][col]
        if x.empty:
            return 0.0
        v = x.max() if agg == "max" else x.sum()
        return float(v) if pd.notna(v) else 0.0

    def kr(self, indice, col):
        x = self.ind[self.ind._ind == chave(indice)][col]
        if x.empty or pd.isna(x.max()):
            raise SemDado(f"Indicadores sem {indice} em {self.d:%d/%m/%Y}")
        return float(x.max())


def cor_principal(v):        # Cor_FO / regra de sinal dos gráficos de barra
    return LARANJA if v >= 0 else VERMELHO


def cor_alpha(v):
    return TEAL if v >= 0 else VERMELHO


def trio_kr(principal, kr, rotulos):
    """Uma das barras de Performance versus KRs: entidade, KR e alpha."""
    return [
        {"r": rotulos[0], "v": principal, "cor": cor_principal(principal)},
        {"r": rotulos[1], "v": kr, "cor": CINZA_KR},
        {"r": rotulos[2], "v": principal - kr, "cor": cor_alpha(principal - kr)},
    ]


def cabecalho_periodo(d):
    return [rot_q(d), rot_ytd(d)]


# --------------------------------------------------------------------------
# slides
# --------------------------------------------------------------------------
def s_kr_fo(b, d, m):
    """Categorias[Valor] / [Valor_YTD]: Resultado_FO × 13.07% × Alpha. Eixo ±20%."""
    fo_q, fo_y = m.seg("Resultado_FO", "%_Quarter"), m.seg("Resultado_FO", "%_YTD")
    kq, ky = m.kr("13.07%", "QTR"), m.kr("13.07%", "YTD")
    rot = ["Luxor FO", "13,07%", "Alpha"]
    return {"t": "barras", "titulo": "Performance versus KRs", "destaque": "in %",
            "nota": "*Result is net of fees", "colunas": cabecalho_periodo(d),
            "linhas": [[{"barras": trio_kr(fo_q, kq, rot), "fmt": "pct1", "eixo": [-0.2, 0.2]},
                        {"barras": trio_kr(fo_y, ky, rot), "fmt": "pct1", "eixo": [-0.2, 0.2]}]]}


PORTFOLIOS = [("Mangalarga", "Luxor_Manga"), ("Agro", "Luxor_Agro"),
              ("Participações", "Luxor_Participações"), ("Luxor FO", "Resultado_FO")]


def _barras_portfolio(m, col, div=1.0):
    out = []
    for nome, seg in PORTFOLIOS:
        v = m.seg(seg, col) / div
        # Luxor FO sempre teal; os outros pelo sinal DO PRÓPRIO valor (o PBI
        # pintava a barra do YTD pelo sinal do trimestre)
        out.append({"r": nome, "v": v, "cor": TEAL if nome == "Luxor FO" else cor_principal(v)})
    return out


def s_pl_portfolio(b, d, m, titulo="Total P&L by Portfolio", destaque="in R$ mm"):
    """Categorias_Portfolio[Valor_Portfolio(_YTD)] = P&L_Quarter|P&L_YTD / 1e6. Eixo ±150."""
    return {"t": "barras", "titulo": titulo, "destaque": destaque,
            "nota": "*Result is net of fees", "colunas": cabecalho_periodo(d),
            "linhas": [[{"barras": _barras_portfolio(m, "P&L_Quarter", 1e6), "fmt": "num1", "eixo": [-150, 150]},
                        {"barras": _barras_portfolio(m, "P&L_YTD", 1e6), "fmt": "num1", "eixo": [-150, 150]}]]}


def s_retorno_portfolio(b, d, m):
    """Categorias_Portfolio[Retorno_Portfolio(_YTD)] = %_Quarter|%_YTD. Eixo ±50%."""
    return {"t": "barras", "titulo": "Total Return by Portfolio", "destaque": "in %",
            "nota": "*Result is net of fees", "colunas": cabecalho_periodo(d),
            "linhas": [[{"barras": _barras_portfolio(m, "%_Quarter"), "fmt": "pct1", "eixo": [-0.5, 0.5]},
                        {"barras": _barras_portfolio(m, "%_YTD"), "fmt": "pct1", "eixo": [-0.5, 0.5]}]]}


def fmt_mm(v):
    """FORMAT(x/1e6, "#,0") com separador pt-BR: 'BRL 1.053 mm'."""
    return f"{round(v / 1e6):,}".replace(",", ".")


def fmt_pct0(v):
    return f"{round(v * 100):.0f}%"


def fmt_pct1(v):
    return f"{v * 100:.1f}%".replace(".", ",")


CARDS = [("Mangalarga", "Luxor_Manga", TEAL), ("Luxor Agro", "Luxor_Agro", AMARELO_CARD),
         ("Luxor Participações", "Luxor_Participações", CINZA_CARD)]


def _portfolio(m):
    pls = {seg: m.seg(seg, "PL") for _, seg, _ in CARDS}
    total = sum(pls.values())
    return pls, total


def s_portfolio(b, d, m):
    """_Portfolio[AUM_*] e [Pct_*]: PL por veículo e % do NAV dos três."""
    pls, total = _portfolio(m)
    return {"t": "cartoes", "titulo": "Luxor Portfolio", "destaque": f"in {rot_q(d)}",
            "resumo": [f"Net Asset Value  BRL {fmt_mm(total)} mm"],
            "cartoes": [{"nome": nome, "cor": cor,
                         "linhas": [f"BRL {fmt_mm(pls[seg])} mm",
                                    f"{fmt_pct0(pls[seg] / total) if total else '0%'} of NAV"]}
                        for nome, seg, cor in CARDS]}


def s_alavancagem(b, d, m):
    """_Leverage[Lev_*]: dívida por veículo, % da dívida e D/A | D/E."""
    debt = {seg: abs(m.seg(seg, "Debt", "max")) for _, seg, _ in CARDS}
    total = abs(sum(m.seg(seg, "Debt") for _, seg, _ in CARDS))

    def dade(seg):
        return (f"D/A {fmt_pct1(abs(m.seg(seg, 'D/A', 'max')))} | "
                f"D/E {fmt_pct1(abs(m.seg(seg, 'D/E', 'max')))}")

    def pct(seg):
        return f"{fmt_pct0(debt[seg] / total) if total else '0%'} of Debt Value"

    agro_net = abs(m.seg("Luxor_Agro", "Net Debt", "max"))
    return {"t": "cartoes", "titulo": "Leverage", "destaque": f"in {rot_q(d)}",
            "resumo": [f"Debt Value BRL {fmt_mm(total)} mm", dade("Net_Result")],
            "cartoes": [
                {"nome": "Mangalarga", "cor": TEAL,
                 "linhas": [f"BRL {fmt_mm(debt['Luxor_Manga'])} mm", pct("Luxor_Manga"), dade("Luxor_Manga")]},
                {"nome": "Luxor Agro", "cor": AMARELO_CARD,
                 "linhas": [f"BRL {fmt_mm(agro_net)} mm Net Debt", pct("Luxor_Agro"),
                            f"Net D/E {fmt_pct1(abs(m.seg('Luxor_Agro', 'Net D/E', 'max')))}"]},
                {"nome": "Luxor Participações", "cor": CINZA_CARD,
                 "linhas": [f"BRL {fmt_mm(debt['Luxor_Participações'])} mm", pct("Luxor_Participações"),
                            dade("Luxor_Participações")]},
            ]}


FOTO_PARTICIPACOES = "apresentacoes/participacoes.jpg"   # no Blob, sob LuxorControlDatabase/


def s_foto_participacoes(b, d, m):
    """Página de abertura da Luxor Participações: foto + cartão do NAV."""
    pls, total = _portfolio(m)
    seg = "Luxor_Participações"
    # a foto vai UMA vez no JSON (spec["imagens"]); o slide guarda só a chave
    if "participacoes" not in b.imagens:
        img = b.binario(FOTO_PARTICIPACOES)
        b.imagens["participacoes"] = ("data:image/jpeg;base64," + base64.b64encode(img).decode()) if img else None
    return {"t": "foto", "img": "participacoes" if b.imagens["participacoes"] else None,
            "cartao": {"nome": "Luxor Participações", "cor": CINZA_CARD,
                       "linhas": [f"BRL {fmt_mm(pls[seg])} mm",
                                  f"{fmt_pct0(pls[seg] / total) if total else '0%'} of NAV"]}}


def s_kr_participacoes(b, d, m):
    """Categorias_Participacoes[Valor_Participacoes(_YTD)]: Participações × IPCA + 2% × Alpha.
    Eixo automático, como no PBI."""
    rot = ["Luxor Participações", "IPCA + 2%", "Alpha"]
    pq, py = m.seg("Luxor_Participações", "%_Quarter"), m.seg("Luxor_Participações", "%_YTD")
    kq, ky = m.kr("IPCA + 2%", "QTR"), m.kr("IPCA + 2%", "YTD")

    def trio(p, k):
        # o PBI pinta o alpha pela regra de sinal laranja/vermelho (sem teal)
        a = p - k
        return [{"r": rot[0], "v": p, "cor": cor_principal(p)},
                {"r": rot[1], "v": k, "cor": CINZA_KR},
                {"r": rot[2], "v": a, "cor": cor_principal(a)}]

    return {"t": "barras", "titulo": "Performance versus KRs", "destaque": "in %",
            "colunas": cabecalho_periodo(d),
            "linhas": [[{"barras": trio(pq, kq), "fmt": "pct1"},
                        {"barras": trio(py, ky), "fmt": "pct1"}]]}


def _cascata(itens, fim, rot_ini, rot_fim):
    """[(rótulo, valor)…] com o 1º = início; barra final = valor real do fim."""
    barras = [{"r": rot_ini, "v": itens[0][1], "k": "ini"}]
    barras += [{"r": r, "v": v, "k": "d"} for r, v in itens[1:]]
    barras.append({"r": rot_fim, "v": fim, "k": "fim"})
    return {"barras": barras, "fmt": "num1"}


def s_aum_participacoes(b, d, m):
    """Categorias_PartAUM[Valor_PartAUM_Q/_YTD] + NAV_Fim: participacoes_aum_pbi.xlsx."""
    a = b.excel("excel/participacoes_aum_pbi.xlsx")
    q = f"Q{(d.month - 1) // 3 + 1} {d.year}"
    cats = [("NAV Início", None), ("Return", "Return"), ("Subscriptions", "Subscriptions"),
            ("Redemptions", "Redemptions")]

    def painel(filtro, rot_ini):
        x = a[filtro]
        if x.empty:
            raise SemDado(f"participacoes_aum_pbi sem {q}")
        val = lambda c: float(x[x.Category.map(chave) == chave(c)]["Value_R$M"].sum())
        itens = [(r or "", val(c)) for c, r in cats]
        return _cascata(itens, val("NAV Fim"), rot_ini, aum_q(d))

    return {"t": "cascata", "titulo": "AUM Luxor Participações", "destaque": "in R$ mm",
            "colunas": cabecalho_periodo(d),
            "paineis": [painel(a.PeriodLabel == q, aum_q_anterior(d)),
                        painel((a.PeriodLabel == f"YTD {d.year}") & (a.Period == q), aum_ano_anterior(d))]}


def s_retorno_ativo(b, d, m):
    """Categorias_Asset[Retorno_Asset(_YTD)], ordenado por retorno com Participações por último."""
    ativos = [("Outros", "Outros_(Ex._Resgates_Manga_-_Família)"),
              ("Renda Fixa - Família", "Renda_Fixa_-_Família"),
              ("Imobiliário BR", "Imobiliário_Br"), ("Imobiliário US", "Imobiliário_Us"),
              ("Receb. Alv. + Shiva Outros", "Receb._Alv._+_Shiva_Outros"),
              ("Equinos + FPG", "Equinos_+_Fpg")]

    def painel(col):
        bs = [{"r": r, "v": m.seg(s, col)} for r, s in ativos]
        bs.sort(key=lambda x: -x["v"])
        bs.append({"r": "Luxor Participações", "v": m.seg("Luxor_Participações", col)})
        for x in bs:
            x["cor"] = cor_principal(x["v"])
        return {"barras": bs, "fmt": "pct1", "eixo": [-0.5, 0.5]}

    return {"t": "barras", "titulo": "Return by Asset", "destaque": "in %",
            "titulo_pt": 40, "colunas": cabecalho_periodo(d), "rotulo_pequeno": True,
            "linhas": [[painel("%_Quarter"), painel("%_YTD")]]}


# linhas fixas, como os filtros de cada linha do PBI (nível 0 = total, 1 = grupo, 2 = item)
LINHAS_ATIVOS = [
    ("Luxor Participações", 0),
    ("Imobiliário BR", 1), ("Obras de Arte Felix Pacheco", 2), ("Tarituba", 2),
    ("Imobiliário US", 1), ("NYC 3A", 2), ("NYC 5A", 2),
    ("Equinos + FPG", 1), ("Equinos HPG", 2), ("Fazenda Pao Grande", 2),
    ("Receb. Alv. + Shiva Outros", 1),
    ("Renda Fixa - Família", 1),
    ("Outros", 1), ("Caixa - Family Office", 2), ("Passivo Hoteleiro", 2),
    ("Resgates Manga a Liquidar - Família", 2),
]


def _linha(df, nome):
    x = df[df.Asset.map(chave) == chave(nome)]
    if x.empty:
        return None
    if len(x) > 1 and "IsGroup" in x:
        g = x[x.IsGroup.astype(bool)]
        if not g.empty:
            x = g
    return x.iloc[0]


def s_analise_ativos(b, d, m):
    """AssetsAnalysis (assets_analysis_pbi.xlsx) no trimestre."""
    a = b.excel("excel/assets_analysis_pbi.xlsx")
    a = a[pd.to_datetime(a.PeriodDate) == d]
    if a.empty:
        raise SemDado("assets_analysis_pbi sem o trimestre")
    linhas = []
    for nome, nivel in LINHAS_ATIVOS:
        r = _linha(a, nome)
        if r is None:
            continue
        linhas.append({"r": nome, "n": nivel,
                       "v": [num(r["Weight"]), num(r["NAV_R$M"]), num(r["PnL_Q_R$M"]), num(r["Return_Q"]),
                             num(r["PnL_YTD_R$M"]), num(r["Return_YTD"])]})
    return {"t": "ativos", "titulo": "Assets analysis", "destaque": "in R$mm", "titulo_pt": 40,
            "colunas": cabecalho_periodo(d), "linhas": linhas}


LINHAS_FCF = [("Imobiliário BR", 1), ("Obras de Arte Felix Pacheco", 2), ("Tarituba", 2),
              ("Imobiliário US", 1), ("NYC 3A", 2), ("NYC 5A", 2),
              ("Equinos + FPG", 1), ("Equinos HPG", 2), ("Fazenda Pao Grande", 2)]


def s_fcf(b, d, m):
    """FCF_Summary (fcf_analysis_pbi.xlsx) no trimestre."""
    f = b.excel("excel/fcf_analysis_pbi.xlsx", "FCF_Summary")
    f = f[pd.to_datetime(f.PeriodDate) == d]
    if f.empty:
        raise SemDado("fcf_analysis_pbi sem o trimestre")
    linhas = []
    for nome, nivel in LINHAS_FCF:
        r = _linha(f, nome)
        if r is None:
            continue
        linhas.append({"r": nome, "n": nivel,
                       "v": [num(r["NAV_R$M"]), num(r["FCF_Q_R$M"]), num(r["FCF_YTD_R$M"]), num(r["NAV_Pct"])]})
    return {"t": "fcf", "titulo": "FCF analysis", "destaque": "in R$mm",
            "colunas": cabecalho_periodo(d), "linhas": linhas}


def s_shiva(b, d, m):
    """Categorias_ShivaWF[Valor_ShivaWF_Q/_YTD]: alvorada_waterfall_pbi.xlsx.
    O PBI pegava sempre o último período da base; aqui é o do trimestre do deck."""
    s = b.excel("excel/alvorada_waterfall_pbi.xlsx")
    s = s[pd.to_datetime(s.PeriodDate) == d]
    if s.empty:
        raise SemDado("alvorada_waterfall_pbi sem o trimestre")
    cats = [("NAV Start", ""), ("Return Manga", "Return Manga"), ("Receivables", "Receivables"),
            ("Expenses", "Expenses"), ("Redemption", "Redemption")]

    def painel(vt, rot_ini):
        x = s[s.ViewType == vt]
        val = lambda c: float(x[x.Category.map(chave) == chave(c)]["Value_R$M"].sum())
        return _cascata([(r, val(c)) for c, r in cats], val("NAV End"), rot_ini, aum_q(d))

    return {"t": "cascata", "titulo": "Alvorada Receivables + Shiva Others", "destaque": "in R$mm",
            "titulo_pt": 32, "colunas": cabecalho_periodo(d),
            "paineis": [painel(rot_q(d), aum_q_anterior(d)), painel(rot_ytd(d), aum_ano_anterior(d))]}


def s_precos_alvorada(b, d, m):
    """alvoradaprices[Price_Display]: Apr-23, todo Dec-yy e o último período até a data do deck."""
    p = b.excel("excel/alvorada_prices_pbi.xlsx")
    p = p.assign(PeriodDate=pd.to_datetime(p.PeriodDate))
    ate = p[p.PeriodDate <= d]
    if ate.empty:
        raise SemDado("alvorada_prices_pbi sem período até a data")
    ultimo = ate.Period.max()
    vis = ate[(ate.PeriodLabel == "Apr-23") | ate.PeriodLabel.str.startswith("Dec-") | (ate.Period == ultimo)]

    def painel(comm, titulo, cor):
        x = vis[vis.Commodity == comm].sort_values("PeriodDate")
        return {"titulo": titulo, "cor": cor, "fmt": "num1",
                "barras": [{"r": r.PeriodLabel, "v": float(r.Price)} for r in x.itertuples()]}

    return {"t": "colunas", "titulo": "Alvorada Receivables", "destaque": "in R$mm",
            "paineis": [painel("Soy", "Soy in R$/saca", LARANJA), painel("Cattle", "Cattle in R$/Arroba", TEAL)]}


CORES_RECEB = {"Soy Receivable": "FFC866", "Soy Received": "FFA400", "Cattle Received": "1D6E79",
               "Cattle Receivable": "2792A1", "Initial Payment": "8C8C8C", "Taxes Paid": "8B0000",
               "Taxes Payable": "CC3333"}
LEGENDA_RECEB = ["Cattle Receivable", "Cattle Received", "Soy Receivable", "Soy Received",
                 "Initial Payment", "Taxes Paid", "Taxes Payable"]


def s_recebiveis(b, d, m):
    """ReceivablesData: posição original (Apr-23) × a mais recente até a data do deck.
    O PBI tinha o slicer travado em 'Jun-26'; aqui é o último snapshot até o trimestre."""
    r = b.excel("excel/alvorada_receivables_pbi.xlsx")
    r = r.assign(PeriodDate=pd.to_datetime(r.PeriodDate))
    ate = r[r.PeriodDate <= d]
    if ate.empty:
        raise SemDado("alvorada_receivables_pbi sem período até a data")
    x = ate[ate.PeriodOrder == ate.PeriodOrder.max()].sort_values("SortOrder")
    rot_atual = str(x.PeriodLabel.iloc[0])

    def pilha(col):
        return [{"s": c["Category"], "v": float(c[col]), "cor": CORES_RECEB.get(c["Category"], "8C8C8C")}
                for c in x.to_dict("records") if pd.notna(c[col])]

    orig = pilha("OriginalValue_R$M")
    atual = pilha("CurrentValue_R$M")
    imposto = {"Taxes Paid", "Taxes Payable"}

    def tot(p, inclui):
        return sum(c["v"] for c in p if (c["s"] in imposto) == inclui)

    soja = sum(c["v"] for c in atual if c["s"] in ("Soy Received", "Soy Receivable"))
    boi = sum(c["v"] for c in atual if c["s"] in ("Cattle Received", "Cattle Receivable"))
    return {"t": "recebiveis", "titulo": "Alvorada Receivables sale", "destaque": "in R$mm",
            "nota": "*Pre-Tax value",
            "legenda": [{"s": s, "cor": CORES_RECEB[s]} for s in LEGENDA_RECEB],
            "barras": [{"r": "Apr-23", "partes": orig, "total": tot(orig, False), "impostos": tot(orig, True)},
                       {"r": rot_atual, "partes": atual, "total": tot(atual, False), "impostos": tot(atual, True),
                        "boi": boi, "soja": soja}]}


# ---------------- Board ----------------
SEG_RESGATE = "Aplicações_E_Resgates_Da_Família"
SEG_IR = "Ir_Retido_(Resgates_Da_Família)"
SEG_CASH = "Cashburn_Family_Office"


def _resultado_fo(m):
    """Dados[Diff_Caixa_FO] e [Delta_NAV_YTD]. O PBI fixava 31/12/2025 como base;
    aqui é o PL_AnoAnterior do Net_Result (fim do ano anterior ao deck)."""
    pnl = m.seg("Resultado_FO", "P&L_YTD", "max")
    cash = m.seg(SEG_CASH, "P&L_YTD", "max")
    ir = m.seg(SEG_IR, "P&L_YTD", "max")
    resg = m.seg(SEG_RESGATE, "P&L_YTD", "max")
    pl = m.seg("Net_Result", "PL", "max")
    pl_ant = m.seg("Net_Result", "PL_AnoAnterior", "max")
    diff = pl - pl_ant - pnl - cash - ir - resg
    return {"pnl": pnl, "cash": cash, "ir": ir, "resg": resg, "diff": diff,
            "delta": pnl + cash + ir + resg + diff}


def s_resultado_fo(b, d, m, agrupado=False):
    r = _resultado_fo(m)
    linhas = [["Net Result", r["pnl"]], ["Cash Burn Fo", r["cash"]]]
    if agrupado:
        linhas.append(["Redemption Family", r["resg"] + r["ir"]])
    else:
        linhas += [["Redemption Family", r["resg"]], ["Redemption Taxes", r["ir"]]]
    linhas.append(["Diff.", r["diff"]])
    return {"t": "resultado_fo", "titulo": "Luxor FO Result",
            "linhas": linhas, "total": [f"∆ NAV YTD {d.year}", r["delta"]]}


def s_aum_grupo(b, d, m, agrupado=False):
    """Categorias_AUM_Waterfall[Valor_AUM_Waterfall]: do AUM do fim do ano anterior ao atual.
    O PBI dividia o Diff por 1e6 duas vezes (saía sempre 0,0)."""
    r = _resultado_fo(m)
    itens = [("", m.seg("Resultado_FO", "PL_AnoAnterior") / 1e6),
             ("Mangalarga", m.seg("Luxor_Manga", "P&L_YTD") / 1e6),
             ("Luxor Participações", m.seg("Luxor_Participações", "P&L_YTD") / 1e6),
             ("Luxor Agro", m.seg("Luxor_Agro", "P&L_YTD") / 1e6),
             ("Cashburn FO", m.seg(SEG_CASH, "P&L_YTD") / 1e6)]
    if agrupado:
        itens.append(("Redemption Family", (m.seg(SEG_RESGATE, "P&L_YTD") + m.seg(SEG_IR, "P&L_YTD")) / 1e6))
    else:
        itens += [("Redemption Family", m.seg(SEG_RESGATE, "P&L_YTD") / 1e6),
                  ("Redemption Taxes", m.seg(SEG_IR, "P&L_YTD") / 1e6)]
    itens.append(("Diff", r["diff"] / 1e6))
    fim = m.seg("Resultado_FO", "PL") / 1e6
    return {"t": "cascata", "titulo": f"AUM Luxor Group YTD {d.year}", "destaque": "In R$mm",
            "paineis": [_cascata(itens, fim, aum_ano_anterior(d), aum_q(d))]}


def _rotulo_mes_en(s):
    """'Dez-07' -> 'Dec-07' (a base grava o mês em português)."""
    mm = re.fullmatch(r"([A-Za-zç]{3})-(\d{2})", str(s))
    return f"{MESES_PT_EN.get(mm.group(1).title(), mm.group(1))}-{mm.group(2)}" if mm else str(s)


CORES_NAV = {"Luxor Agro": "FFC866", "Mangalarga": "31859C", "Luxor Participações": "CBD2D0",
             "Luxor Group": "1D6E79"}


def s_nav_crescimento(b, d, m):
    """NAV_Board (nav_growth_by_month.xlsx) com ReferenceDate = data do deck."""
    n = b.excel("excel/nav_growth_by_month.xlsx")
    n = n[pd.to_datetime(n.ReferenceDate) == d]
    if n.empty:
        raise SemDado("nav_growth_by_month sem a data")
    ordem = (n[["Category", "CategoryOrder"]].drop_duplicates().sort_values("CategoryOrder").Category.tolist())
    barras = []
    for (bd, bl), x in n.groupby([pd.to_datetime(n.BarDate), "BarLabel"], sort=True):
        partes = []
        for cat in ordem:
            v = x[x.Category == cat]["Value_RS_mi"].sum()
            if v:
                partes.append({"s": cat, "v": float(v), "cor": CORES_NAV.get(cat, "8C8C8C")})
        # r = rótulo em inglês (board); rp = o da base, em português (carta em PT)
        barras.append({"r": _rotulo_mes_en(bl), "rp": str(bl), "partes": partes,
                       "total": float(x["Value_RS_mi"].sum())})
    return {"t": "pilhas", "titulo": "New Asset Value", "destaque": "| Growth",
            "legenda": [{"s": c, "cor": CORES_NAV.get(c, "8C8C8C")} for c in ordem],
            "barras": barras}


def s_resultado_patrimonial(b, d, m):
    """EvPatrimonialResult (patrimonial_result_yearly.xlsx) com ReferenceDate = data do deck."""
    e = b.excel("excel/patrimonial_result_yearly.xlsx")
    e = e[pd.to_datetime(e.ReferenceDate) == d].sort_values("Order")
    if e.empty:
        raise SemDado("patrimonial_result_yearly sem a data")
    return {"t": "colunas", "titulo": "Evolution of Patrimonial Result", "destaque": "in R$mm",
            "paineis": [{"fmt": "num1", "barras": [
                {"r": str(r.AxisLabel), "v": float(r.Value_RS_mi),
                 "cor": TEAL if float(r.Value_RS_mi) >= 0 else VERMELHO} for r in e.itertuples()]}]}


def s_kr_board(b, d, m):
    """Performance versus KRs do board: FO, Mangalarga (USD), Agro e Participações."""
    def trio(p, k, rot, alpha_teal=True):
        a = p - k
        return [{"r": rot[0], "v": p, "cor": cor_principal(p)},
                {"r": rot[1], "v": k, "cor": CINZA_KR},
                {"r": rot[2], "v": a, "cor": cor_alpha(a) if alpha_teal else cor_principal(a)}]

    def linha(pq, py, kq, ky, rot):
        return [{"barras": trio(pq, kq, rot), "fmt": "pct1"}, {"barras": trio(py, ky, rot), "fmt": "pct1"}]

    return {"t": "barras", "titulo": "Performance versus", "destaque": "KRs", "compacto": True,
            "colunas": cabecalho_periodo(d),
            "linhas": [
                linha(m.seg("Resultado_FO", "%_Quarter"), m.seg("Resultado_FO", "%_YTD"),
                      m.kr("13.07%", "QTR"), m.kr("13.07%", "YTD"), ["Luxor FO", "13,07%", "Alpha"]),
                linha(m.kr("mangalarga usd", "QTR"), m.kr("mangalarga usd", "YTD"),
                      m.kr("85% s&p + 15% sofr", "QTR"), m.kr("85% s&p + 15% sofr", "YTD"),
                      ["Mangalarga", "85% S&P | 15% SOFR", "Alpha"]),
                linha(m.seg("Luxor_Agro", "%_Quarter"), m.seg("Luxor_Agro", "%_YTD"),
                      m.kr("ipca + 10%", "QTR"), m.kr("ipca + 10%", "YTD"), ["Luxor Agro", "IPCA + 10%", "Alpha"]),
                linha(m.seg("Luxor_Participações", "%_Quarter"), m.seg("Luxor_Participações", "%_YTD"),
                      m.kr("IPCA + 2%", "QTR"), m.kr("IPCA + 2%", "YTD"),
                      ["Luxor Participações", "IPCA + 2%", "Alpha"]),
            ]}


CORES_LEV = {"Mangalarga D/E": "F2A900", "Luxor USA D/E": "CC3333", "Luxor Group D/E": "6BA5A5",
             "Luxor Agro Net Debt/E": "B5A66B", "US Real Estate D/A": "FFFFFF"}


def s_alavancagem_custo(b, d, m):
    """Series/Kd (leverage_debt_cost.xlsx) até o período do deck (o PBI usava o slicer SlicerLev)."""
    s = b.excel("excel/leverage_debt_cost.xlsx", "Series")
    k = b.excel("excel/leverage_debt_cost.xlsx", "Kd")
    sel = d.year * 100 + d.month
    s = s[s.PeriodOrder <= sel]
    if s.empty or s.PeriodOrder.max() != sel:
        raise SemDado("leverage_debt_cost sem o período do deck")
    periodos = s[["PeriodOrder", "PeriodLabel"]].drop_duplicates().sort_values("PeriodOrder")
    series = []
    for nome, x in s.sort_values("PeriodOrder").groupby("Series", sort=False):
        kd = k[(k.PeriodOrder == sel) & (k.KdSeries == nome)]["Kd"].dropna()
        series.append({"s": nome, "o": int(x.SeriesOrder.iloc[0]), "cor": CORES_LEV.get(nome, "FFFFFF"),
                       "eixo2": nome == "US Real Estate D/A",
                       "kd": float(kd.min()) if not kd.empty else None,
                       "pontos": [[periodos.PeriodOrder.tolist().index(p), float(v)]
                                  for p, v in zip(x.PeriodOrder, x.Value) if pd.notna(v)]})
    series.sort(key=lambda x: x["o"])
    return {"t": "linhas", "titulo": "Leverage & Debt Cost",
            "nota": ["* Kd is expressed in USD for Mangalarga and US Real Estate, and in BRL for Luxor Agro.",
                     "** Luxor Group D/E represents the weighted average of the individual entities."],
            "rotulos": periodos.PeriodLabel.tolist(), "eixo": [0, 0.21], "eixo2": [0, 0.72],
            "series": series}


TOTAIS_INVEST = {"Total Co-Investors", "Luxor Group Equity", "Luxor Group Asset"}


def s_investidores(b, d, m):
    """coinvestors (hist_report_data.xlsx), em BRL e USD — a tela troca a moeda."""
    c = b.excel("excel/hist_report_data.xlsx", "coinvestors")
    c = c[pd.to_datetime(c.Ref_Date) == d]
    if c.empty:
        raise SemDado("hist_report_data/coinvestors sem a data")
    moedas = {}
    for moeda, x in c.groupby("Currency"):
        x = x.sort_values("Order")
        asset = float(x[x.Item_Name == "Luxor Group Asset"]["AUM"].sum())
        moedas[moeda] = {
            "membros": [[r.Members_Breakdown if isinstance(r.Members_Breakdown, str) else r.Item_Name, int(r.Members)]
                        for r in x.itertuples() if pd.notna(r.Members) and int(r.Members) != 0],
            "barras": [{"r": r.Item_Name, "v": float(r.AUM) / 1e6, "k": "fim" if r.Item_Name in TOTAIS_INVEST else "d"}
                       for r in x.itertuples()],
            # Calculations[Luxor_Group_AUM]: "#,## Mi" em USD, "#,##0.00 Bi" em BRL (pt-BR)
            "frase": (f"• Luxor Group has US${f'{asset / 1e6:,.0f}'.replace(',', '.')} Mi asset under management."
                      if moeda == "USD" else
                      f"• Luxor Group has R${f'{asset / 1e9:.2f}'.replace('.', ',')} Bi asset under management."),
        }
    return {"t": "investidores", "titulo": "NAV Break Down", "destaque": "by Investors",
            "data": d.strftime("%d/%m/%Y"), "moedas": moedas, "padrao": "BRL" if "BRL" in moedas else next(iter(moedas))}


def s_capa_budget(b, d, m):
    return {"t": "capa", "texto": f"Budget {d.year}"}


def s_budget_fc(b, d, m):
    """fato_budget_fc: a aba Comitê do fluxo de caixa do FO, linha a linha (cor e negrito
    da própria planilha). O PBI mostrava o print do Excel."""
    f = b.parquet("parquet/fato_budget_fc.parquet")
    f = f[pd.to_datetime(f.DataFechamento) == d].sort_values("Ordem")
    if f.empty:
        raise SemDado("fato_budget_fc sem o fechamento")
    r0 = f.iloc[0]
    cols = ["MesOrc", "MesReal", "MesDelta", "YtdOrc", "YtdReal", "YtdDelta", "YtdPctPL", "AnoOrc", "AnoRealOrc"]
    linhas = []
    for r in f.itertuples():
        if bool(r.Separador):
            linhas.append({"sep": True})
            continue
        rot = r.Rotulo if isinstance(r.Rotulo, str) else ""
        fill = r.Fill.lstrip("#").upper() if isinstance(r.Fill, str) and r.Fill.strip() else None
        # linha branca sem negrito (Salários, Encargos, Bônus, Treinamentos) fica oculta
        # no slide, como na aba Comitê; Saldo Inicial e Receita Líquida são brancas em negrito
        if fill is None and not bool(r.Negrito):
            continue
        linhas.append({"r": rot, "fill": fill, "b": bool(r.Negrito), "v": [num(getattr(r, c)) for c in cols]})
    return {"t": "budget_fc", "titulo": "Budget |", "destaque": str(d.year),
            "grupos": [str(r0.RotuloMes), str(r0.RotuloYtd), str(r0.RotuloAno)],
            "cabecalho": f"Fluxo de Caixa {d.year} | Family Office", "linhas": linhas}


def s_highlights(b, d, m):
    """fato_budget_highlights: os quatro quadrantes do Budget Highlights."""
    h = b.parquet("parquet/fato_budget_highlights.parquet")
    h = h[pd.to_datetime(h.DataFechamento) == d]
    if h.empty:
        raise SemDado("fato_budget_highlights sem o fechamento")
    ordem = ["Management Fees", "Investment Team Brazil", "Luxor USA", "Administrative Activities Brazil"]
    quads = []
    for q in ordem + sorted(set(h.Quadrante) - set(ordem)):
        x = h[h.Quadrante == q].sort_values("Ordem")
        if x.empty:
            continue
        quads.append({"q": q, "itens": [{"r": r.Rotulo, "v": num(r.Valor), "fav": bool(r.Favoravel)}
                                         for r in x.itertuples()]})
    return {"t": "highlights", "titulo": "Budget Highlights |",
            "destaque": f"Q{(d.month - 1) // 3 + 1} {d.year} in R$", "quadrantes": quads}


def s_receita_segmento(b, d, m):
    """fato_slide1_segmento (FC_Slides.xlsx). A coluna YoY % do PBI não estava ligada a
    campo nenhum e saía vazia; aqui vem da coluna YoY da base."""
    f = b.excel("excel/FC_Slides.xlsx", "fato_slide1_segmento")
    f = f[pd.to_datetime(f.DataFechamento) == d]
    if f.empty:
        raise SemDado("FC_Slides sem o fechamento")
    linhas = []
    for seg in ("Luxor Grupo", "Funds", "Agro & Real Estate"):
        x = f[f.Segmento == seg]
        linhas.append([seg, num(x.Revenue_RMM.sum()) if not x.empty else None,
                       num(x.YoY.iloc[0]) if not x.empty else None])
    return {"t": "receita", "titulo": "Luxor Group Revenue", "destaque": f"by Segment @{d.year}",
            "cab": ["Investor", "Revenue in R$mm", "YoY %"], "linhas": linhas}


def s_receita_manga(b, d, m):
    """fato_slide2_mangalarga (FC_Slides.xlsx)."""
    f = b.excel("excel/FC_Slides.xlsx", "fato_slide2_mangalarga")
    f = f[pd.to_datetime(f.DataFechamento) == d]
    if f.empty:
        raise SemDado("FC_Slides sem o fechamento")
    linhas = []
    for inv, rot in (("Funds", "Funds"), ("Family", "Family"), ("Employee", "Employee"),
                     ("Co-Investors", "Co-investors")):
        x = f[f.Investidor == inv]
        linhas.append([rot, num(x.Revenue_RMM.sum()) if not x.empty else None,
                       num(x.Pct.iloc[0]) if not x.empty else None])
    return {"t": "receita", "titulo": "Mangalarga Revenue", "destaque": f"by Investor @{d.year}",
            "cab": ["Investor", "Revenue in R$mm", "%"], "linhas": linhas,
            "nota_centro": "We refund the management fee to the employees."}


# ---------------- Carta Trimestral (PT e EN) ----------------
# A carta tem 6 páginas em retrato. Os NÚMEROS saem daqui (os mesmos gráficos do
# Comitê/Board e o do PBI "Carta trimestral"); os TEXTOS do CEO, a seção de leituras e a
# tradução são colados na própria aba (app_state 'carta') e entram no navegador.
# As imagens fixas (logo da capa, Propósito e Valores em PT e EN) ficam no Blob, em
# LuxorControlDatabase/apresentacoes/carta/, e vão uma vez só no JSON (spec["imagens"]).
IMAGENS_CARTA = {
    "carta_logo": ("apresentacoes/carta/logo_luxor.svg", "image/svg+xml"),
    "carta_proposito_pt": ("apresentacoes/carta/proposito_pt.png", "image/png"),
    "carta_valores_pt": ("apresentacoes/carta/valores_pt.png", "image/png"),
    "carta_proposito_en": ("apresentacoes/carta/proposito_en.png", "image/png"),
    "carta_valores_en": ("apresentacoes/carta/valores_en.png", "image/png"),
}


def _imagem(b, chave):
    if chave not in b.imagens:
        rel, mime = IMAGENS_CARTA[chave]
        dado = b.binario(rel)
        b.imagens[chave] = f"data:{mime};base64,{base64.b64encode(dado).decode()}" if dado else None
    return chave if b.imagens[chave] else None


def s_carta_capa(b, d, m):
    return {"t": "carta_capa", "rotulo": f"Q{(d.month - 1) // 3 + 1} {d.year}", "logo": _imagem(b, "carta_logo")}


def s_carta_proposito(b, d, m):
    return {"t": "carta_proposito", "img": {k.rsplit("_", 1)[0].replace("carta_", "") + "_" + k.rsplit("_", 1)[1]:
                                             _imagem(b, k) for k in IMAGENS_CARTA if k != "carta_logo"}}


def s_carta_retornos(b, d, m):
    """Página 4: Retorno do Grupo Luxor vs IPCA (PBI "Carta trimestral",
    Categorias_FO_IPCA) e Retorno por Portfolio (o Total Return by Portfolio do Comitê)."""
    sr = b.excel("excel/hist_report_data.xlsx", "segment_returns")
    x = sr[(pd.to_datetime(sr.Ref_Date) == d) & (sr.Segment.map(chave) == chave("Resultado_Patrimonial"))]["36M"]
    if x.empty or pd.isna(x.iloc[0]):
        raise SemDado("hist_report_data/segment_returns sem o 36M do Resultado_Patrimonial")
    fo36 = float(x.iloc[0])
    paineis = [
        [m.seg("Resultado_FO", "%_Quarter"), m.kr("IPCA", "QTR")],
        [m.seg("Resultado_FO", "%_YTD"), m.kr("IPCA", "YTD")],
        [fo36, m.kr("IPCA", "36 Meses")],
    ]
    retorno = s_retorno_portfolio(b, d, m)["linhas"][0]
    return {"t": "carta_retornos", "q": rot_q(d), "ytd": rot_ytd(d), "ipca": paineis,
            "portfolio": [[{"r": x["r"], "v": x["v"], "cor": x["cor"]} for x in p["barras"]] for p in retorno]}


def s_carta_patrimonio(b, d, m):
    """Página 5: Evolução do Patrimônio (NAV_Board) e Alocação por Portfolio (cartões)."""
    nav = s_nav_crescimento(b, d, m)
    port = s_portfolio(b, d, m)
    return {"t": "carta_patrimonio", "barras": nav["barras"], "legenda": nav["legenda"], "cartoes": port["cartoes"]}


def s_carta_texto(slot):
    def f(b, d, m):
        return {"t": "carta_texto", "slot": slot}
    return f


ROTEIRO = {
    "comite_fo": [
        ("kr_fo", s_kr_fo), ("retorno_portfolio", s_retorno_portfolio), ("pl_portfolio", s_pl_portfolio),
        ("portfolio", s_portfolio), ("alavancagem", s_alavancagem), ("foto_participacoes", s_foto_participacoes),
        ("kr_participacoes", s_kr_participacoes), ("aum_participacoes", s_aum_participacoes),
        ("retorno_ativo", s_retorno_ativo), ("analise_ativos", s_analise_ativos), ("fcf", s_fcf),
        ("shiva", s_shiva), ("precos_alvorada", s_precos_alvorada), ("recebiveis", s_recebiveis),
    ],
    "board_fo": [
        ("portfolio", s_portfolio),
        ("resultado_fo", s_resultado_fo),
        ("resultado_fo_agrupado", lambda b, d, m: s_resultado_fo(b, d, m, agrupado=True)),
        ("aum_grupo", s_aum_grupo),
        ("aum_grupo_agrupado", lambda b, d, m: s_aum_grupo(b, d, m, agrupado=True)),
        ("nav_crescimento", s_nav_crescimento), ("resultado_patrimonial", s_resultado_patrimonial),
        ("resultado_atividade", lambda b, d, m: s_pl_portfolio(b, d, m, "Result by Activity", "in R$ mm")),
        ("kr_board", s_kr_board), ("alavancagem_custo", s_alavancagem_custo),
        ("investidores", s_investidores), ("capa_budget", s_capa_budget), ("budget_fc", s_budget_fc),
        ("highlights", s_highlights), ("receita_segmento", s_receita_segmento), ("receita_manga", s_receita_manga),
    ],
    "carta": [
        ("capa", s_carta_capa), ("proposito", s_carta_proposito), ("destaques", s_carta_texto("destaques")),
        ("retornos", s_carta_retornos), ("patrimonio", s_carta_patrimonio),
        ("atualizacoes", s_carta_texto("atualizacoes")),
    ],
}
# página do deck em px a 96 dpi (o PPTX sai no mesmo tamanho): os slides do PBI eram
# 1280×720; a carta é retrato, 9,25×11,81 pol, como o PPTX dela
PAGINA = {"carta": {"w": 888, "h": 1134}}


def monta_deck(b: Bases, deck: str, d: pd.Timestamp) -> tuple[list, list]:
    """Slides do deck no trimestre `d`. Slide sem dado vira `pendente` com o motivo."""
    try:
        m = Medidas(b, d)
    except SemDado as e:
        return [], [str(e)]
    slides, avisos = [], []
    for sid, fn in ROTEIRO[deck]:
        try:
            s = fn(b, d, m)
        except SemDado as e:
            s = {"t": "pendente", "titulo": sid, "motivo": str(e)}
            avisos.append(f"{sid}: {e}")
        s["id"] = sid
        slides.append(s)
    return slides, avisos


# --------------------------------------------------------------------------
# publicado (congelamento)
# --------------------------------------------------------------------------
def env_supabase():
    from dotenv import dotenv_values
    cfg = {**dotenv_values(ROOT / ".env"), **os.environ}
    url = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_ROLE_KEY")
    return (url, key) if url and key else (None, None)


def publicado(deck: str) -> dict | None:
    """O JSON que está no bucket agora. Sem credencial ou sem arquivo, None."""
    url, key = env_supabase()
    if not url:
        return None
    import requests
    r = requests.get(f"{url}/storage/v1/object/{BUCKET}/{deck}.json",
                     headers={"Authorization": f"Bearer {key}"}, timeout=60)
    if r.status_code == 200:
        return r.json()
    if r.status_code in (400, 404):
        return None
    sys.exit(f"Não consegui ler o {deck}.json publicado (HTTP {r.status_code}). "
             "Sem ele não dá pra saber o que está congelado; use --sem-publicado só em teste.")


def ultimo_trimestre(b: Bases) -> pd.Timestamp:
    g = b.dados
    datas = sorted(g.Date[g.Date.dt.month.isin([3, 6, 9, 12])].unique())
    if not datas:
        sys.exit("group_hist_data sem nenhum fim de trimestre.")
    return pd.Timestamp(datas[-1])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("decks", nargs="*", help=f"um ou mais de {', '.join(DECKS)} (padrão: todos)")
    ap.add_argument("--tri", help="trimestre a gerar (AAAA-QN). Padrão: o último com dado.")
    ap.add_argument("--refazer", action="store_true",
                    help="permite regerar um trimestre que não é o mais recente do publicado")
    ap.add_argument("--desde", help="carga inicial: gera todos os trimestres desde AAAA-QN até o último")
    ap.add_argument("--bases", type=Path, help="pasta local com as planilhas (em vez do Blob)")
    ap.add_argument("--sem-publicado", action="store_true", help="não mescla com o publicado (teste)")
    a = ap.parse_args()
    a.decks = a.decks or list(DECKS)
    errado = [x for x in a.decks if x not in DECKS]
    if errado:
        sys.exit(f"Deck desconhecido: {', '.join(errado)}. Válidos: {', '.join(DECKS)}")

    b = Bases(a.bases)
    ultimo = ultimo_trimestre(b)
    if a.desde:
        ini = fim_tri(a.desde)
        alvos = []
        d = ini
        while d <= ultimo:
            alvos.append(d)
            d = (d + pd.DateOffset(months=3)) + pd.offsets.MonthEnd(0)
    else:
        alvos = [fim_tri(a.tri) if a.tri else ultimo]

    agora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for deck in a.decks:
        base = None if a.sem_publicado else publicado(deck)
        spec = base or {"deck": deck, "titulo": TITULO_DECK[deck], "decks": {}, "labels": {},
                        "gerado_por_periodo": {}, "fontes": {}}
        spec["pagina"] = PAGINA.get(deck, {"w": 1280, "h": 720})
        b.imagens = {}          # só as imagens que ESTE deck usa vão no JSON dele
        ja = sorted(spec.get("decks", {}))
        mais_recente = ja[-1] if ja else None
        for d in alvos:
            tri = tri_de(d)
            if (not a.refazer and not a.desde and tri in spec["decks"]
                    and mais_recente and tri < mais_recente):
                sys.exit(f"[{deck}] {tri} já foi publicado e não é o trimestre mais recente "
                         f"({mais_recente}). Trimestre fechado não se regera; use --refazer se for de propósito.")
            slides, avisos = monta_deck(b, deck, d)
            if not slides:
                print(f"[{deck}] {tri}: sem dado ({'; '.join(avisos)}) — mantido como estava")
                continue
            spec["decks"][tri] = slides
            spec["labels"][tri] = rot_q(d)
            spec.setdefault("gerado_por_periodo", {})[tri] = agora
            spec.setdefault("avisos_por_periodo", {})[tri] = avisos
            print(f"[{deck}] {tri}: {len(slides)} slides" + (f" — {len(avisos)} pendente(s): {'; '.join(avisos)}"
                                                           if avisos else ""))
        spec["periodos"] = sorted(spec["decks"], reverse=True)
        spec["padrao"] = spec["periodos"][0] if spec["periodos"] else None
        spec["gerado_em"] = agora
        spec["fontes"] = {**spec.get("fontes", {}), **b.fontes}
        spec["imagens"] = {**spec.get("imagens", {}), **{k: v for k, v in b.imagens.items() if v}}
        OUT.mkdir(parents=True, exist_ok=True)
        corpo = json.dumps(spec, ensure_ascii=False, allow_nan=False)
        (OUT / f"{deck}.json").write_text(corpo, encoding="utf-8")
        (OUT / f"{deck}.js").write_text(f"window.APRESENTACAO_{deck.upper()}={corpo};", encoding="utf-8")
        print(f"[{deck}] gravado {OUT / (deck + '.json')} ({len(corpo) // 1024} KB)")


if __name__ == "__main__":
    main()

