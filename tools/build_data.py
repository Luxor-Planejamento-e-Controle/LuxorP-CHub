"""Extrai dados reais (Indicadores no Azure + DRE no Drive) e gera JS embutido
para a versão offline do hub (file:// não faz fetch, então vira window.*).

Uso: python tools/build_data.py
Requer: pandas, pyarrow, azure-storage-blob, python-dotenv e a conn do Azure
(pega do .env do FinancialIndicators).
"""
import io, os, json, sys, unicodedata
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "data"
OUT.mkdir(parents=True, exist_ok=True)
DRE_XLSX = r"G:/Drives compartilhados/Luxor Controladoria/Ambiente de testes/DRE Data/DRE_Historico.xlsx"
FIN_ENV = Path(r"C:/Users/Arthur/repos/FinancialIndicators/.env")
CONTAINER = "luxor-planejamento-e-controle"
IND_BLOB = "LuxorControlDatabase/Indicadores_financeiros.parquet"
GROUP_BLOB = "LuxorControlDatabase/parquet/group_hist_data.parquet"   # pipeline do FO

# Segmentos do group_hist_data que viram série de cota no Indicadores.
# O arquivo tem 46 segmentos, a maioria linha contábil interna (Ir_Retido,
# Despesas_Escritório, Cashburn...), cuja "Quota" não é cota de fundo. Aqui só
# os veículos e os resultados. Pra ver a lista toda com período e nº de meses:
#     python tools/build_data.py --segmentos
SEGMENTOS = [
    ("Resultado_FO",                    "Resultado FO"),
    ("Luxor_Investimentos_Financeiros", "Luxor Investimentos Financeiros"),
    ("Luxor_Agro",                      "Luxor Agro"),
    ("Luxor_Manga",                     "Luxor Manga"),
    ("Luxor_Mangalarga_I",              "Luxor Mangalarga I"),
    ("Luxor_Mangalarga_Ii",             "Luxor Mangalarga II"),
    ("Luxor_Participações",             "Luxor Participações"),
    ("Net_Result",                      "Resultado Líquido"),
    ("Resultado_Patrimonial",           "Resultado Patrimonial"),
]


def azure_conn():
    from dotenv import dotenv_values
    return dotenv_values(FIN_ENV)["AZURE_STORAGE_CONNECTION_STRING"]


def write(name, var, payload):
    """Grava os dois formatos: .json (produção, vai pro bucket privado via
    publish_hub.py) e .js (demo offline em file://, que não faz fetch)."""
    blob = json.dumps(payload, ensure_ascii=False)
    (OUT / f"{name}.json").write_text(blob, encoding="utf-8")
    (OUT / f"{name}.js").write_text(f"window.{var}={blob};", encoding="utf-8")


def pc(v):
    return None if (v is None or pd.isna(v)) else round(float(v) * 100, 2)


def read_blob(bsc, path):
    bc = bsc.get_blob_client(CONTAINER, path)
    return pd.read_parquet(io.BytesIO(bc.download_blob().readall()))


def _sem_acento(s):
    """Compara nome de segmento sem depender de acento/caixa — os nomes vêm
    do pipeline do FO e já mudaram de grafia antes."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(s))
                   if not unicodedata.combining(c)).lower()


def build_segmento(gdf, segmento):
    """Um segmento do group_hist_data vira série de cota, como se fosse um
    ticker. Série MENSAL (fechamento de mês), então:
      px  = Quota * 100  -> índice base 100 (Quota é acumulado contínuo, não
            reinicia por ano; conferido na base)
      dia = None         -> não existe variação diária nessa série
      mtd/qtr/ytd        = %_MoM / %_Quarter / %_YTD (já calculados na fonte)
      m36                = Quota[i]/Quota[i-36]-1 (só quando há 36 meses)
    Obs: o group_hist_data vem com as linhas fora de ordem (o mês mais recente
    pode aparecer no topo do arquivo), daí o sort/drop_duplicates por Date.
    """
    alvo = _sem_acento(segmento)
    g = gdf[gdf["Segment"].map(_sem_acento) == alvo].dropna(subset=["Date", "Quota"])
    g = (g.sort_values("Date").drop_duplicates("Date", keep="last").reset_index(drop=True))
    if g.empty:
        raise ValueError(f"segmento '{segmento}' não existe ou está sem Quota")
    q = g["Quota"].astype(float)
    rows = []
    for i in range(len(g)):
        m36 = (q.iloc[i] / q.iloc[i - 36] - 1) if i >= 36 else None
        rows.append([pd.Timestamp(g["Date"].iloc[i]).strftime("%Y-%m-%d"),
                     round(q.iloc[i] * 100, 4), None,
                     pc(g["%_MoM"].iloc[i]), pc(g["%_Quarter"].iloc[i]),
                     pc(g["%_YTD"].iloc[i]), pc(m36)])
    return rows


def listar_segmentos():
    """Imprime os segmentos disponíveis, p/ ajustar a lista SEGMENTOS."""
    from azure.storage.blob import BlobServiceClient
    g = read_blob(BlobServiceClient.from_connection_string(azure_conn()), GROUP_BLOB)
    g = g.dropna(subset=["Date", "Quota"])
    usados = {_sem_acento(s) for s, _ in SEGMENTOS}
    print(f"{'segmento':<40} {'meses':>6}  período              no hub")
    for seg, sub in sorted(g.groupby("Segment")):
        ini, fim = sub["Date"].min(), sub["Date"].max()
        marca = "sim" if _sem_acento(seg) in usados else ""
        print(f"{seg:<40} {len(sub):>6}  {ini:%Y-%m} a {fim:%Y-%m}      {marca}")


def build_indicadores():
    from azure.storage.blob import BlobServiceClient
    b = BlobServiceClient.from_connection_string(azure_conn())
    df = read_blob(b, IND_BLOB)
    df = df.sort_values("Data")

    # Manga/Lipi: limitar exibição a partir de 2020 (histórico anterior existe, mas não interessa aqui)
    lim2020 = df["Índice"].str.startswith(("Mangalarga", "Lipizzaner")) & (df["Data"] < "2020-01-01")
    df = df[~lim2020]

    out, fantasy = {}, []
    for idx, g in df.groupby("Índice"):
        g = g.sort_values("Data").reset_index(drop=True)
        d = g["Data"]
        cota = g["Cotação"].astype(float)
        # cotação real (preço/NAV) se preenchida e variando; senão índice sintético.
        real = cota.notna().all() and (cota.nunique() / len(g) > 0.5)
        if real:
            px = cota
        else:
            # "Variação Diária" é taxa diária-CALENDÁRIO. Compõe por dias corridos
            # entre linhas (inclui fim de semana), senão anualiza errado (ex.: 13,07%).
            vd = g["Variação Diária"].fillna(0).astype(float)
            dias = d.diff().dt.days.fillna(0)
            px = 100 * ((1 + vd) ** dias).cumprod()
            fantasy.append(idx)
        # MÉTRICAS = colunas da FONTE (a pipeline dele já computa correto). Não recomputar.
        rows = []
        for i in range(len(g)):
            rows.append([d.iloc[i].strftime("%Y-%m-%d"), round(float(px.iloc[i]), 4),
                         pc(g["Variação Diária"].iloc[i]), pc(g["Mensal"].iloc[i]),
                         pc(g["QTR"].iloc[i]), pc(g["YTD"].iloc[i]), pc(g["36 Meses"].iloc[i])])
        out[idx] = rows

    # Cotas do group_hist_data entram na mesma lista (outra fonte, série mensal).
    # Falha num segmento não derruba o resto — o painel sobe sem ele.
    monthly = []
    try:
        gdf = read_blob(b, GROUP_BLOB)
        for seg, label in SEGMENTOS:
            try:
                out[label] = build_segmento(gdf, seg)
                fantasy.append(label)     # cota, não preço de mercado
                monthly.append(label)
                print(f"[indicadores] {label}: {len(out[label])} meses "
                      f"({out[label][0][0]} a {out[label][-1][0]})")
            except Exception as e:
                print(f"[indicadores] {label} ignorado:", e, file=sys.stderr)
    except Exception as e:
        print("[indicadores] group_hist_data indisponível:", e, file=sys.stderr)

    indices = sorted(out.keys())
    payload = {"indices": indices, "rows": out, "fantasy": sorted(fantasy),
               "monthly": sorted(monthly),
               "cols": ["data", "px", "dia", "mtd", "qtr", "ytd", "m36"]}
    write("indicadores", "IND_DATA", payload)
    print(f"[indicadores] {len(indices)} índices ({len(fantasy)} fantasia), {len(df)} linhas -> indicadores.json/.js")


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
    write("dre", "DRE_DATA", payload)
    print(f"[dre] ytd={len(ytd_rows)} geral={len(ger_rows)} naturezas={len(payload['naturezas'])} -> dre.json/.js")


if __name__ == "__main__":
    if "--segmentos" in sys.argv:            # só lista, não gera nada
        listar_segmentos()
        sys.exit(0)
    try:
        build_indicadores()
    except Exception as e:
        print("[indicadores] ERRO:", e, file=sys.stderr)
    build_dre()
