"""Extrai dados reais (Indicadores no Azure + DRE no Drive) e gera JS embutido
para a versão offline do hub (file:// não faz fetch, então vira window.*).

Uso: python tools/build_data.py [indicadores|dre ...]
     (sem argumento = os dois)
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
IND_BLOB = "LuxorControlDatabase/parquet/Indicadores_financeiros.parquet"
GROUP_BLOB = "LuxorControlDatabase/parquet/group_hist_data.parquet"   # pipeline do FO

# Segmentos do group_hist_data que viram série de cota no Indicadores.
# O arquivo tem 46 segmentos, a maioria linha contábil interna (Ir_Retido,
# Despesas_Escritório, Cashburn...), cuja "Quota" não é cota de fundo. Aqui só
# os veículos e os resultados. Pra ver a lista toda com período e nº de meses:
#     python tools/build_data.py --segmentos
SEGMENTOS = [
    ("Resultado_FO", "Resultado FO"),
]

# Cotas de fundos vindas da CVM (informe diário por CNPJ). Quem baixa e publica
# é o cvm.py em "Relatórios de Gestão/Novo Extrato de Cotista/Composição de
# Dividendos/cotas/", que ao salvar o cache sobe pro Blob. Aqui só lemos.
QUOTAS_BLOB = "LuxorControlDatabase/parquet/funds_quotas_historico.parquet"
# (nome na coluna FUNDO, rótulo no hub). Esta é a fonte oficial das cotas de
# fundos no Indicadores — o Indicadores_financeiros.parquet também traz
# Manga/Lipi, mas essas linhas são descartadas (ver PREFIXOS_VIA_CVM) pra não
# ficar a mesma série duas vezes, com nome e origem diferentes.
FUNDOS_COTA = [(n, n) for n in (
    "Lipizzaner",
    "Lipizzaner USD",
    "Mangalarga I",
    "Mangalarga I USD",
    "Mangalarga II",
    "Mangalarga II USD",
    "Mangalarga Consolidado",
    "Mangalarga Consolidado USD",
    "Mastercash",
    "Tesouro Selic",
)]
# Índices do parquet de indicadores que agora vêm da CVM e devem ser ignorados lá.
PREFIXOS_VIA_CVM = ("Mangalarga", "Lipizzaner")


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
      m36                = Quota[i]/Quota[i-36]-1 quando há 36 meses; com menos
            que isso, o ACUMULADO DESDE O INÍCIO (deixar vazio jogaria fora
            informação que existe). O rótulo no hub muda junto, senão viraria
            comparação errada com quem tem 36 meses de verdade — quem avisa é
            o `parcial36` do payload.

    Devolve (rows, meses).

    Obs: o group_hist_data vem com as linhas fora de ordem (o mês mais recente
    pode aparecer no topo do arquivo), daí o sort/drop_duplicates por Date.
    """
    alvo = _sem_acento(segmento)
    g = gdf[gdf["Segment"].map(_sem_acento) == alvo].dropna(subset=["Date", "Quota"])
    g = (g.sort_values("Date").drop_duplicates("Date", keep="last").reset_index(drop=True))
    if g.empty:
        raise ValueError(f"segmento '{segmento}' não existe ou está sem Quota")
    q = g["Quota"].astype(float)
    # Base do índice = valor ANTES do primeiro mês. A Quota da 1ª linha já
    # embute o retorno daquele mês, então dividir por ela subestimaria o
    # acumulado no primeiro mês inteiro.
    mom0 = float(g["%_MoM"].iloc[0] or 0)
    base = q.iloc[0] / (1 + mom0) if (1 + mom0) else q.iloc[0]
    rows = []
    for i in range(len(g)):
        m36 = (q.iloc[i] / q.iloc[i - 36] - 1) if i >= 36 else (q.iloc[i] / base - 1)
        rows.append([pd.Timestamp(g["Date"].iloc[i]).strftime("%Y-%m-%d"),
                     round(q.iloc[i] * 100, 4), None,
                     pc(g["%_MoM"].iloc[i]), pc(g["%_Quarter"].iloc[i]),
                     pc(g["%_YTD"].iloc[i]), pc(m36)])
    return rows, len(g)


def build_cotas(bsc):
    """Cotas de fundos publicadas pelo cvm.py no Blob. Já vêm com cota real e as
    variações prontas (VAR_DIA/MTD/QTD/YTD/36M em fração), com a mesma semântica
    do parquet de indicadores — então NÃO recalcula nada, só reempacota.
    Devolve {rótulo: rows} no formato [data, px, dia, mtd, qtr, ytd, m36].
    """
    df = read_blob(bsc, QUOTAS_BLOB)
    df["DATA"] = pd.to_datetime(df["DATA"])
    out = {}
    for fundo, label in FUNDOS_COTA:
        g = (df[df["FUNDO"] == fundo].dropna(subset=["DATA", "COTA"])
               .sort_values("DATA").drop_duplicates("DATA", keep="last"))
        if g.empty:
            print(f"[indicadores] {label}: sem linhas em {QUOTAS_BLOB}", file=sys.stderr)
            continue
        out[label] = [[r["DATA"].strftime("%Y-%m-%d"), round(float(r["COTA"]), 6),
                       pc(r["VAR_DIA"]), pc(r["MTD"]), pc(r["QTD"]),
                       pc(r["YTD"]), pc(r["36M"])] for _, r in g.iterrows()]
        print(f"[indicadores] {label}: {len(out[label])} pontos "
              f"({out[label][0][0]} a {out[label][-1][0]})")
    return out


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

    # Manga/Lipi saem daqui: a fonte oficial dessas cotas passou a ser a CVM
    # (funds_quotas_historico, ver build_cotas). Sem isso, a mesma série
    # apareceria duas vezes — "Mangalarga BRL" (parquet) e "Mangalarga II" (CVM).
    df = df[~df["Índice"].str.startswith(PREFIXOS_VIA_CVM)]

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
    monthly, parcial36 = [], {}
    try:
        gdf = read_blob(b, GROUP_BLOB)
        for seg, label in SEGMENTOS:
            try:
                out[label], meses = build_segmento(gdf, seg)
                fantasy.append(label)     # cota, não preço de mercado
                monthly.append(label)
                if meses < 36:            # coluna "36M" traz o acumulado do período
                    parcial36[label] = meses
                print(f"[indicadores] {label}: {len(out[label])} meses "
                      f"({out[label][0][0]} a {out[label][-1][0]})"
                      + (f" — 36M mostra acumulado de {meses}m" if meses < 36 else ""))
            except Exception as e:
                print(f"[indicadores] {label} ignorado:", e, file=sys.stderr)
    except Exception as e:
        print("[indicadores] group_hist_data indisponível:", e, file=sys.stderr)

    # Cotas de fundos (CVM). Cota real e série diária, então não entram em
    # fantasy nem em monthly. Falha aqui também não derruba o resto.
    try:
        out.update(build_cotas(b))
    except Exception as e:
        print("[indicadores] cotas de fundos indisponíveis:", e, file=sys.stderr)

    indices = sorted(out.keys())
    payload = {"indices": indices, "rows": out, "fantasy": sorted(fantasy),
               "monthly": sorted(monthly),
               # {índice: nº de meses} — nesses, a coluna m36 é acumulado do
               # período, não 36 meses. O hub rotula diferente.
               "parcial36": parcial36,
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
    # Sem argumento = os dois, como sempre foi. Com argumento, só o pedido —
    # o run_etl_indicadores.py atualiza indicadores sem mexer no dre.json.
    alvos = [a for a in sys.argv[1:] if not a.startswith("-")] or ["indicadores", "dre"]
    desconhecido = [a for a in alvos if a not in ("indicadores", "dre")]
    if desconhecido:
        sys.exit(f"Dataset inválido: {', '.join(desconhecido)}. Use indicadores e/ou dre.")
    if "indicadores" in alvos:
        try:
            build_indicadores()
        except Exception as e:
            print("[indicadores] ERRO:", e, file=sys.stderr)
    if "dre" in alvos:
        build_dre()
