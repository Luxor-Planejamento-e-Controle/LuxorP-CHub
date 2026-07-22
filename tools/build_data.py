"""Extrai dados reais (Indicadores no Azure + DRE no Drive) e gera JS embutido
para a versão offline do hub (file:// não faz fetch, então vira window.*).

Uso: python tools/build_data.py
Requer: pandas, pyarrow, azure-storage-blob, python-dotenv e a conn do Azure
(pega do .env do FinancialIndicators).
"""
import io, os, json, sys
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "data"
OUT.mkdir(parents=True, exist_ok=True)
DRE_XLSX = r"G:/Drives compartilhados/Luxor Controladoria/Ambiente de testes/DRE Data/DRE_Historico.xlsx"
FIN_ENV = Path(r"C:/Users/Arthur/repos/FinancialIndicators/.env")


def azure_conn():
    from dotenv import dotenv_values
    return dotenv_values(FIN_ENV)["AZURE_STORAGE_CONNECTION_STRING"]


def build_indicadores():
    from azure.storage.blob import BlobServiceClient
    b = BlobServiceClient.from_connection_string(azure_conn())
    bc = b.get_blob_client("luxor-planejamento-e-controle",
                           "LuxorControlDatabase/Indicadores_financeiros.parquet")
    df = pd.read_parquet(io.BytesIO(bc.download_blob().readall()))
    df = df.sort_values("Data")
    pct = ["Variação Diária", "Mensal", "QTR", "YTD", "36 Meses"]
    out = {}
    for idx, g in df.groupby("Índice"):
        rows = []
        for _, r in g.iterrows():
            def p(c):
                v = r[c]
                return None if pd.isna(v) else round(float(v) * 100, 2)
            cota = None if pd.isna(r["Cotação"]) else round(float(r["Cotação"]), 4)
            rows.append([r["Data"].strftime("%Y-%m-%d"), cota,
                         p("Variação Diária"), p("Mensal"), p("QTR"), p("YTD"), p("36 Meses")])
        out[idx] = rows
    indices = sorted(out.keys())
    payload = {"indices": indices, "rows": out,
               "cols": ["data", "cota", "dia", "mtd", "qtr", "ytd", "m36"]}
    (OUT / "indicadores.js").write_text(
        "window.IND_DATA=" + json.dumps(payload, ensure_ascii=False) + ";",
        encoding="utf-8")
    print(f"[indicadores] {len(indices)} índices, {len(df)} linhas -> indicadores.js")


def _nat_order(df):
    """Lista de Natureza Ordenada na ordem do campo 'Ordem' (como no PBIX)."""
    nn = df[["Natureza Ordenada", "Ordem", "É Subtotal"]].dropna(subset=["Natureza Ordenada"]).copy()
    nn = nn.sort_values("Ordem").drop_duplicates("Natureza Ordenada")
    return [[r["Natureza Ordenada"], bool(r["É Subtotal"])] for _, r in nn.iterrows()]


def build_dre():
    xl = pd.ExcelFile(DRE_XLSX)

    # ---- Comparativo YTD (Base YTD Unpivot): barras Orçado x Realizado por ano.
    # Grão completo (com Natureza Ordenada) p/ o JS replicar exatamente os slicers do PBIX.
    u = xl.parse("Base YTD Unpivot")
    ytd = (u.groupby(["Modelo", "Centro de Custo", "Acumulado", "Natureza Ordenada", "Ano", "Cenário"],
                     dropna=False)["Valor YTD"].sum().reset_index())
    ytd_rows = [[r["Modelo"], r["Centro de Custo"], r["Acumulado"], r["Natureza Ordenada"],
                 int(r["Ano"]), r["Cenário"], round(float(r["Valor YTD"]), 2)]
                for _, r in ytd.iterrows() if pd.notna(r["Natureza Ordenada"])]

    # ---- Orçado x Realizado (Base DRE Geral): linha por Data de Fechamento
    g = xl.parse("Base DRE Geral")
    g["Data de Fechamento"] = pd.to_datetime(g["Data de Fechamento"])
    ger = (g.groupby(["Modelo", "Centro de Custo", "Natureza Ordenada", "Data de Fechamento"], dropna=False)[["Orçado", "Realizado"]]
             .sum().reset_index().sort_values("Data de Fechamento"))
    ger_rows = [[r["Modelo"], r["Centro de Custo"], r["Natureza Ordenada"],
                 r["Data de Fechamento"].strftime("%Y-%m-%d"),
                 round(float(r["Orçado"]), 2), round(float(r["Realizado"]), 2)]
                for _, r in ger.iterrows() if pd.notna(r["Natureza Ordenada"])]

    payload = {
        "modelos": sorted(u["Modelo"].dropna().unique().tolist()),
        "centros": sorted(u["Centro de Custo"].dropna().unique().tolist()),
        "acumulados": sorted(u["Acumulado"].dropna().unique().tolist()),
        "anos": sorted(int(a) for a in u["Ano"].dropna().unique()),
        "naturezas": _nat_order(u),
        "ytd": {"cols": ["modelo", "cc", "acumulado", "natureza", "ano", "cenario", "valor"], "rows": ytd_rows},
        "geral": {"cols": ["modelo", "cc", "natureza", "data", "orcado", "realizado"], "rows": ger_rows},
    }
    (OUT / "dre.js").write_text(
        "window.DRE_DATA=" + json.dumps(payload, ensure_ascii=False) + ";", encoding="utf-8")
    print(f"[dre] ytd={len(ytd_rows)} geral={len(ger_rows)} naturezas={len(payload['naturezas'])} -> dre.js")


if __name__ == "__main__":
    try:
        build_indicadores()
    except Exception as e:
        print("[indicadores] ERRO:", e, file=sys.stderr)
    build_dre()
