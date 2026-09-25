"""Extrai dados reais (Indicadores no Azure + DRE e Fluxo de Caixa locais) e gera
JS embutido para a versão offline do hub (file:// não faz fetch, então vira window.*).

Uso: python tools/build_data.py [indicadores|dre|fluxo ...]
     (sem argumento = todos)
Requer: pandas, pyarrow, azure-storage-blob, python-dotenv e a conn do Azure
(pega do .env do FinancialIndicators).
"""
import io, os, json, sys, unicodedata
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "data"
OUT.mkdir(parents=True, exist_ok=True)
# Saída do LxDREdataExtractor, que grava AO LADO DE SI MESMO. Apontava para a
# cópia em "Ambiente de testes" no Drive — pasta deprecated desde 26/08/2026
# (a Controladoria migrou pros repositórios), e a cópia de lá parou em
# 18/08/2026: o hub publicava DRE de quatro semanas atrás sem nada sinalizando,
# porque o arquivo EXISTE — só não anda. Mesma fonte que o HubHPG já usa.
DRE_XLSX = os.environ.get(
    "DRE_HISTORICO",
    r"C:/Users/Arthur/repos/LuxorMonthlyP-CRoutines/DRE Data/DRE_Historico.xlsx")
# Saída do FCDataExtractor (mesmo repo do DRE): uma base por fluxo de caixa,
# Bases_FC/FC_{OPERACAO}__{Empresa}.xlsx, aba fato_fluxo.
FC_DIR = Path(os.environ.get(
    "FC_BASES",
    r"C:/Users/Arthur/repos/LuxorMonthlyP-CRoutines/FCDataExtractor/Bases_FC"))
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

# Séries sem preço viram índice sintético compondo a "Variação Diária". A taxa é
# diária-CALENDÁRIO na maioria (13,07%, IPCA+2%...), mas o CDI é taxa de DIA
# ÚTIL: compor por dias corridos multiplica o fim de semana e infla a série.
# Medido no payload de 31/08/2026: CDI rebaseado dava YTD 13,08% e 36M 65,73%,
# contra 9,32%/43,89% das colunas da fonte — e o Tesouro Selic, que acompanha o
# CDI e tem cota real, fechou 9,24%/43,33%. Aqui o expoente é 1 por linha.
TAXAS_DIA_UTIL = {"CDI"}


def azure_conn():
    """Connection string do Blob. Ambiente primeiro, .env local depois.

    A ordem importa: rodando como Container App Job no Azure não existe .env nem
    o disco desta máquina — a conn vem de secret em variável de ambiente. Na
    máquina do dia a dia o .env continua valendo.
    """
    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if conn:
        return conn
    from dotenv import dotenv_values
    if FIN_ENV.exists():
        conn = dotenv_values(FIN_ENV).get("AZURE_STORAGE_CONNECTION_STRING")
    if not conn:
        sys.exit("Falta AZURE_STORAGE_CONNECTION_STRING (ambiente ou "
                 f"{FIN_ENV}).")
    return conn


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
    # A base vira PONTO no gráfico (fechamento do mês anterior ao primeiro).
    # Sem ela a curva começa já rendida — Resultado FO abria em 101,1435 e medir
    # a série inteira no gráfico dava +21,21% contra os +22,60% do acumulado,
    # que parte de 100. Linha só de âncora: nenhuma variação da fonte se aplica
    # a ela, então as métricas ficam vazias.
    if abs(base - q.iloc[0]) > 1e-12:
        d0 = pd.Timestamp(g["Date"].iloc[0])
        anc = (d0.replace(day=1) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        rows.append([anc, round(base * 100, 4), None, None, None, None, None])
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


def _meses_hist(rows):
    """Meses inteiros cobertos pela série. Serve pra saber se o "36 Meses" da
    fonte é, na prática, o acumulado desde o início. Série que abre no dia 1
    cobre o mês inteiro, daí o +1."""
    ini, fim = pd.Timestamp(rows[0][0]), pd.Timestamp(rows[-1][0])
    m = (fim.year - ini.year) * 12 + (fim.month - ini.month)
    return m + 1 if ini.day <= 2 else m


def build_indicadores():
    from azure.storage.blob import BlobServiceClient
    b = BlobServiceClient.from_connection_string(azure_conn())
    df = read_blob(b, IND_BLOB)
    df = df.sort_values("Data")

    # Manga/Lipi saem daqui: a fonte oficial dessas cotas passou a ser a CVM
    # (funds_quotas_historico, ver build_cotas). Sem isso, a mesma série
    # apareceria duas vezes — "Mangalarga BRL" (parquet) e "Mangalarga II" (CVM).
    df = df[~df["Índice"].str.startswith(PREFIXOS_VIA_CVM)]

    out, fantasy, parcial36 = {}, [], {}
    for idx, g in df.groupby("Índice"):
        g = g.sort_values("Data").reset_index(drop=True)
        d = g["Data"]
        cota = g["Cotação"].astype(float)
        # cotação real (preço/NAV) se preenchida e variando; senão índice sintético.
        real = cota.notna().all() and (cota.nunique() / len(g) > 0.5)
        if real:
            px = cota
        else:
            # "Variação Diária" é taxa diária-CALENDÁRIO: compõe por dias corridos
            # entre linhas (inclui fim de semana), senão anualiza errado (ex.: 13,07%).
            # Exceção: taxa de dia útil (CDI) compõe uma vez por linha — ver
            # TAXAS_DIA_UTIL.
            vd = g["Variação Diária"].fillna(0).astype(float)
            if idx in TAXAS_DIA_UTIL:
                dias = pd.Series(1.0, index=g.index)
                dias.iloc[0] = 0.0                 # 1ª linha ancora o índice em 100
            else:
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
        # Série mais nova que 36 meses: a coluna "36 Meses" da fonte traz o
        # acumulado desde o início (conferido no 13.07%, que começa em
        # 01/01/2024 e fecha ago/26 com 38,71% = a série inteira). Rotular isso
        # como 36M põe lado a lado períodos diferentes. Se a coluna vier vazia,
        # não há o que rotular — o hub já avisa que falta histórico.
        meses_hist = _meses_hist(rows)
        if meses_hist < 36 and rows[-1][6] is not None:
            parcial36[idx] = meses_hist
            # Sendo acumulado do período, a coluna tem que bater com o que o
            # gráfico mostra ao medir a série inteira — é a mesma pergunta. A
            # fonte chega nele por day-count (365,25) e crava o aniversário em
            # 31/12; o índice compõe a Variação Diária dia a dia e faz
            # aniversário em 01/01 (o 13.07% vale exatamente 113,0701 em
            # 01/01/2025). Dava 38,71% contra 38,70% no mesmo período. Fica o
            # realizado do índice, regra que build_segmento já usa no acumulado
            # parcial. Só nas séries curtas: onde há 36 meses de verdade a
            # coluna é janela móvel, não acumulado, e vem da fonte.
            base_px = rows[0][1]
            for r in rows:
                r[6] = pc(r[1] / base_px - 1) if base_px else None

    # Cotas do group_hist_data entram na mesma lista (outra fonte, série mensal).
    # Falha num segmento não derruba o resto — o painel sobe sem ele.
    monthly = []
    try:
        gdf = read_blob(b, GROUP_BLOB)
        for seg, label in SEGMENTOS:
            try:
                out[label], meses = build_segmento(gdf, seg)
                fantasy.append(label)     # cota, não preço de mercado
                monthly.append(label)
                if meses < 36:            # coluna "36M" traz o acumulado do período
                    parcial36[label] = meses
                print(f"[indicadores] {label}: {meses} meses "
                      f"({out[label][0][0]} a {out[label][-1][0]}, "
                      f"{len(out[label])} pontos c/ âncora da base)"
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


# Operações na ordem do FCDataExtractor (OPERATIONS); rótulo = pasta de
# Relatórios Gerenciais de onde a base sai.
FC_OPERACOES = [("INVESTIMENTOS", "Investimentos"), ("AGRONEGOCIO", "Agronegócio"),
                ("HARAS_FPG", "Haras e Fazenda PG"), ("IMOBILIARIA", "Imobiliária"),
                ("PASSIVO", "Passivo")]
FC_ABAS = ["Resumo", "Receitas", "Despesas"]
# Mesmas faixas do Acumulado do DRE: faixa N = Jan até o mês N.
FC_ACUMULADOS = [f"{m:02d}-Jan a {n}" for m, n in enumerate(
    ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"], 1)]


def build_fluxo():
    """Fluxos de caixa de todas as entidades, no molde do DRE Orçado × Realizado.

    Valor com sinal (ValorSinalizado: saída de caixa negativa), como no DRE, e
    acumulado do ano pronto do ETL (ValorSinalizadoAcumulado, que já trata saldo
    como a planilha: Saldo Inicial de janeiro, Saldo Final do mês). Aqui só se
    agrega. A natureza é (aba, Natureza Ordenada): o mesmo nome existe no Resumo
    e na aba de Receitas/Despesas, e somar os dois contaria a linha duas vezes.
    """
    arquivos = sorted(FC_DIR.glob("FC_*__*.xlsx"))
    if not arquivos:
        raise FileNotFoundError(f"nenhuma base FC_*.xlsx em {FC_DIR}")
    cols = ["Operacao", "Empresa", "Data", "Aba", "Natureza Ordenada", "Ordem", "Nivel",
            "Cenario", "ValorSinalizado", "ValorSinalizadoAcumulado"]
    df = pd.concat([pd.read_excel(p, sheet_name="fato_fluxo", usecols=cols) for p in arquivos],
                   ignore_index=True)
    df = df.dropna(subset=["Natureza Ordenada"])
    df["Data"] = pd.to_datetime(df["Data"])
    op_ordem = {k: i for i, (k, _) in enumerate(FC_OPERACOES)}
    op_nome = dict(FC_OPERACOES)
    aba_ix = {a: i for i, a in enumerate(FC_ABAS)}

    fluxos, naturezas, rows = [], {}, []
    pares = sorted(df.groupby(["Operacao", "Empresa"]).groups,
                   key=lambda k: (op_ordem.get(k[0], 99), k[1]))
    for fi, (op, emp) in enumerate(pares):
        d = df[(df["Operacao"] == op) & (df["Empresa"] == emp)]
        # lista de naturezas na ordem da face do fluxo: aba, depois Ordem do ETL
        nat = (d.groupby(["Aba", "Natureza Ordenada"])
                .agg(ordem=("Ordem", "min"), sub=("Nivel", lambda s: bool((s != "conta").any())))
                .reset_index())
        nat["ai"] = nat["Aba"].map(aba_ix)
        nat = nat.sort_values(["ai", "ordem"]).reset_index(drop=True)
        lista, idx, vl = [], {}, None
        for i, r in nat.iterrows():
            nome = str(r["Natureza Ordenada"])
            chave = _sem_acento(nome.split(" ", 1)[-1]).strip()
            saldo = ""
            if r["Aba"] == "Resumo":
                saldo = "ini" if chave.startswith("saldo inicial") else "fim" if chave.startswith("saldo final") else ""
                if chave == "variacao liquida":
                    vl = i
            lista.append([nome, int(r["ai"]), bool(r["sub"]), saldo])
            idx[(r["Aba"], nome)] = i
        if vl is None:
            raise ValueError(f"{op}/{emp}: Resumo sem linha de Variação Líquida")
        # último mês com Realizado: a planilha traz o ano inteiro, e depois do
        # fechamento o Realizado é zero, não "ainda não aconteceu". Só conta (linha
        # com código) decide: a planilha repete o último saldo nos meses abertos,
        # e a VARIAÇÃO CAMBIAL do FO (sem código) já traz valor em set/2026.
        rz = d[(d["Nivel"] == "conta") & (d["Cenario"] == "Realizado")
               & (d["ValorSinalizado"].abs() > 0.005)]
        # E o mês corrente nunca está fechado: a Controladoria lança no mês
        # aberto (em 25/09/2026 o Condomínio HPG já tinha realizado de setembro)
        # e sem o teto o painel abria em setembro, com o mês pela metade.
        ref = min(rz["Data"].max(), pd.Timestamp.today().normalize().replace(day=1) - pd.Timedelta(days=1))
        fluxos.append({"op": op_nome.get(op, op), "nome": emp, "vl": vl,
                       "ref": ref.strftime("%Y-%m-%d")})
        naturezas[fi] = lista

        # Cenário que a planilha não traz fica null, não zero: o Orçado de
        # despesa do FO em 2020 é #VALUE! na fonte, e zero ali seria orçamento zero.
        g = (d.groupby(["Aba", "Natureza Ordenada", "Data", "Cenario"])
              [["ValorSinalizado", "ValorSinalizadoAcumulado"]].sum(min_count=1).unstack("Cenario"))
        for (aba, nome, data), v in g.iterrows():
            vals = [None if pd.isna(x := v.get((c, cen))) else round(float(x), 2)
                    for c in ("ValorSinalizado", "ValorSinalizadoAcumulado")
                    for cen in ("Orçado", "Realizado")]
            if not any(vals):
                continue                       # linha zerada: o front lê ausência como 0
            rows.append([fi, idx[(aba, nome)], data.strftime("%Y-%m-%d")] + vals)

    payload = {
        "fluxos": fluxos,
        "abas": FC_ABAS,
        "acumulados": FC_ACUMULADOS,
        "naturezas": naturezas,
        "rows": {"cols": ["fluxo", "natureza", "data", "orcado", "realizado", "orcadoAcum", "realizadoAcum"],
                 "rows": rows},
    }
    write("fluxo", "FC_DATA", payload)
    print(f"[fluxo] {len(fluxos)} fluxos, {len(rows)} linhas -> fluxo.json/.js")


if __name__ == "__main__":
    if "--segmentos" in sys.argv:            # só lista, não gera nada
        listar_segmentos()
        sys.exit(0)
    # Sem argumento = todos. Com argumento, só o pedido — o
    # run_etl_indicadores.py atualiza indicadores sem mexer no dre.json.
    alvos = [a for a in sys.argv[1:] if not a.startswith("-")] or ["indicadores", "dre", "fluxo"]
    desconhecido = [a for a in alvos if a not in ("indicadores", "dre", "fluxo")]
    if desconhecido:
        sys.exit(f"Dataset inválido: {', '.join(desconhecido)}. Use indicadores, dre e/ou fluxo.")
    # Falha de um dataset nao impede o outro, mas TEM que virar exit != 0: rodando
    # como job, sair 0 com o build quebrado faria o publish subir snapshot velho
    # como se fosse novo.
    falhou = []
    if "indicadores" in alvos:
        try:
            build_indicadores()
        except Exception as e:
            print("[indicadores] ERRO:", e, file=sys.stderr)
            falhou.append("indicadores")
    if "dre" in alvos:
        try:
            build_dre()
        except Exception as e:
            print("[dre] ERRO:", e, file=sys.stderr)
            falhou.append("dre")
    if "fluxo" in alvos:
        try:
            build_fluxo()
        except Exception as e:
            print("[fluxo] ERRO:", e, file=sys.stderr)
            falhou.append("fluxo")
    if falhou:
        sys.exit(f"build_data falhou em: {', '.join(falhou)}")
