"""Pipeline do painel Indicadores: fecha o mês nas duas fontes e republica o hub.

É a fatia "indicadores" do `run_all_etls` desenhado em docs/ARQUITETURA.md. Não
reimplementa cálculo nenhum — só chama, na ordem certa, as rotinas que já
existem:

  1. FinancialIndicators/Scripts/azure_monthly_pipeline.py  (índices de mercado)
  2. cotas/cvm.py -> get_quotas_for_date                     (cotas CVM dos fundos)
  3. tools/build_data.py indicadores                         (snapshot do hub)
  4. tools/publish_hub.py indicadores                        (bucket privado)

A ordem entre 1 e 2 é obrigatória: o cvm.py monta a cota USD dividindo a cota
BRL pelo dólar que ele lê do `Indicadores_financeiros.xlsx` no Drive
(`_load_usd_diario`). Cotas antes dos indicadores = mês sem cota USD.

O passo 1 roda em modo Blob (pull -> recomputa -> push), o mesmo do Container
App Job. Consequência importante: o xlsx do Drive é SOBRESCRITO pelo do Blob
antes do cálculo, ou seja o Blob é a cópia autoritativa e o Drive é espelho.
É de propósito — o inverso já empurrou uma vez pro Blob um Drive truncado.

O Resultado FO (`group_hist_data.parquet`, pipeline do LuxorMonthlyFORoutines)
NÃO entra aqui: roda à parte porque o fechamento ainda é provisório. O passo 3
lê o que estiver publicado no Blob.

Agendamento: `run_etl_indicadores_agendado.cmd` (wrapper com log) + tarefa
"Luxor - ETL Indicadores (hub)", definida em `etl_indicadores_task.xml` — dias
1-3 e 5-16 às 08:30 BRT, 30 min depois do Container App Job (cron 11:00 UTC).
Só esses dias porque é quando índice é liberado: 1-3 fecha o mês (dólar e as
diárias), 5-16 cobre cotas CVM (5º dia útil), IPCA e CPI. É o que amarra a
republicação do hub à atualização dos indicadores: o job só mexe no Blob, e o
painel lê o snapshot `indicadores.json` do bucket `hub-data`. Comando de registro
em FinancialIndicators/DEPLOY.md.

Uso:
    python tools/run_etl_indicadores.py                 # último mês fechado
    python tools/run_etl_indicadores.py 07/2026         # mês específico
    python tools/run_etl_indicadores.py --force         # reprocessa sem novidade
    python tools/run_etl_indicadores.py --dry-run       # só mostra o plano
    python tools/run_etl_indicadores.py --skip-publish   # build sem publicar
    python tools/run_etl_indicadores.py --exigir-cotas   # aborta se a CVM não tem o mês

Exit codes: 0 = ok, 1 = falha em algum passo.
"""
import datetime as dt
import io
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Repos/pastas irmãos. Overridable por env pra não travar no layout de uma máquina.
FIN_REPO = Path(os.environ.get("FINANCIALINDICATORS_DIR", ROOT.parent / "FinancialIndicators"))
COTAS_DIR = Path(os.environ.get(
    "LUXOR_COTAS_DIR",
    r"G:/Drives compartilhados/Luxor Controladoria/Relatórios de Gestão/"
    r"Novo Extrato de Cotista/Composição de Dividendos",
))
# Saída do passo 1. Mesmo default do indicadores_financeiros.py — declarado aqui
# porque o blob_sync só liga o pull/push quando essa env var está setada.
INDICADORES_XLSX = Path(os.environ.get(
    "INDICADORES_OUTPUT_FILE",
    r"G:/Drives compartilhados/Luxor Controladoria/Relatórios de Gestão/"
    r"Novo Extrato de Cotista/Inputs Power BI/Indicadores_financeiros.xlsx",
))

BLOB_CONTAINER = "luxor-planejamento-e-controle"
BLOB_PREFIX = "LuxorControlDatabase"
IND_BLOB = f"{BLOB_PREFIX}/parquet/Indicadores_financeiros.parquet"
QUOTAS_BLOB = f"{BLOB_PREFIX}/parquet/funds_quotas_historico.parquet"
GROUP_BLOB = f"{BLOB_PREFIX}/parquet/group_hist_data.parquet"


def log(msg=""):
    print(msg, flush=True)


def passo(n, titulo):
    log(f"\n{'=' * 72}\n[{n}/4] {titulo}\n{'=' * 72}")


def azure_conn():
    """Conn string do Azure — vem do .env do FinancialIndicators (nunca do repo)."""
    from dotenv import dotenv_values
    cs = (dotenv_values(FIN_REPO / ".env").get("AZURE_STORAGE_CONNECTION_STRING")
          or os.environ.get("AZURE_STORAGE_CONNECTION_STRING") or "").strip()
    if not cs:
        sys.exit(f"!! Falta AZURE_STORAGE_CONNECTION_STRING em {FIN_REPO / '.env'}")
    return cs


def mes_alvo(argv):
    """MM/AAAA do argumento, ou o último mês fechado."""
    args = [a for a in argv if not a.startswith("-")]
    if args:
        mes, ano = map(int, args[0].strip().split("/"))
        if len(str(ano)) != 4 or not (1 <= mes <= 12):
            sys.exit("!! Use o formato MM/AAAA.")
        return ano, mes
    hoje = dt.date.today()
    return (hoje.year - 1, 12) if hoje.month == 1 else (hoje.year, hoje.month - 1)


def fim_do_mes(ano, mes):
    return (dt.date(ano + (mes == 12), (mes % 12) + 1, 1) - dt.timedelta(days=1))


# --- Passo 1: índices de mercado (FinancialIndicators) -----------------------

def roda_indicadores(tag, conn, force):
    script = FIN_REPO / "Scripts" / "azure_monthly_pipeline.py"
    if not script.exists():
        log(f"!! {script} não existe. Ajuste FINANCIALINDICATORS_DIR.")
        return False
    env = {
        **os.environ,
        "AZURE_STORAGE_CONNECTION_STRING": conn,   # o blob_sync roda antes do load_dotenv
        "BLOB_SYNC_CONTAINER": BLOB_CONTAINER,
        "BLOB_SYNC_PREFIX": BLOB_PREFIX,
        "INDICADORES_OUTPUT_FILE": str(INDICADORES_XLSX),
        "PYTHONIOENCODING": "utf-8",
    }
    cmd = [sys.executable, str(script), tag] + (["--force"] if force else [])
    return subprocess.run(cmd, cwd=FIN_REPO, env=env).returncode == 0


# --- Passo 2: cotas CVM (cvm.py no Drive) -----------------------------------

def roda_cotas(ano, mes, conn):
    """Chama o get_quotas_for_date do cvm.py: ele baixa o que falta, recalcula as
    métricas, salva o cache no Drive e sobe xlsx+parquet pro Blob. O retorno
    (dict de cotas do mês) não interessa aqui — o que vale é o efeito colateral.
    """
    if not (COTAS_DIR / "cotas" / "cvm.py").exists():
        log(f"!! cvm.py não encontrado em {COTAS_DIR / 'cotas'}. Ajuste LUXOR_COTAS_DIR.")
        return False
    sys.path.insert(0, str(COTAS_DIR))
    os.environ["AZURE_STORAGE_CONNECTION_STRING"] = conn   # habilita o upload do cvm.py
    os.environ.pop("DISABLE_AZURE_OUTPUT_UPLOAD", None)
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(message)s")
    # O upload do cvm.py passa pelo SDK do Azure, que loga request/response
    # inteiros em INFO e afoga a saída dos passos.
    for nome in ("azure", "azure.core.pipeline.policies.http_logging_policy",
                 "urllib3", "requests"):
        logging.getLogger(nome).setLevel(logging.WARNING)
    try:
        from cotas.cvm import CNPJS_COTAS, PATH_QUOTAS_CACHE, get_quotas_for_date
    except Exception as e:
        log(f"!! Falha ao importar o cvm.py: {e}")
        return False
    try:
        get_quotas_for_date(fim_do_mes(ano, mes), PATH_QUOTAS_CACHE, CNPJS_COTAS)
        return True
    except FileNotFoundError as e:
        # Caminho esperado quando a CVM ainda não publicou o informe do mês
        # (sai ~dia 15). Não é bug: é laggard, igual IPCA/CPI.
        log(f"!! CVM ainda sem o mês {mes:02d}/{ano}: {e}")
        return False
    except Exception as e:
        log(f"!! Erro nas cotas CVM: {e}")
        return False


# --- Passos 3 e 4: snapshot e publicação ------------------------------------

def roda_script_hub(nome, *args):
    cmd = [sys.executable, str(ROOT / "tools" / nome), *args]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(cmd, cwd=ROOT, env=env).returncode == 0


# --- Relatório de cobertura -------------------------------------------------

def cobertura(conn):
    """Última data de cada fonte do painel, pra deixar óbvio o que ficou atrás."""
    import pandas as pd
    from azure.storage.blob import BlobServiceClient
    bsc = BlobServiceClient.from_connection_string(conn)

    def ler(path):
        bc = bsc.get_blob_client(BLOB_CONTAINER, path)
        if not bc.exists():
            return None
        return pd.read_parquet(io.BytesIO(bc.download_blob().readall()))

    linhas = []
    for rotulo, path, col, filtro in (
        ("Índices de mercado", IND_BLOB, "Data", None),
        ("Cotas de fundos (CVM)", QUOTAS_BLOB, "DATA", None),
        ("Resultado FO (à parte)", GROUP_BLOB, "Date", "Resultado_FO"),
    ):
        try:
            df = ler(path)
            if df is None or df.empty:
                linhas.append((rotulo, "sem arquivo no Blob"))
                continue
            if filtro and "Segment" in df.columns:
                df = df[df["Segment"].astype(str).str.lower() == filtro.lower()]
            fim = pd.to_datetime(df[col], errors="coerce").max()
            linhas.append((rotulo, fim.date().strftime("%d/%m/%Y") if pd.notna(fim) else "vazio"))
        except Exception as e:
            linhas.append((rotulo, f"erro: {e}"))

    log("\nCobertura das fontes no Blob:")
    for rotulo, valor in linhas:
        log(f"  {rotulo:<26} {valor}")


def main():
    argv = sys.argv[1:]
    force = "--force" in argv
    dry = "--dry-run" in argv
    skip_publish = "--skip-publish" in argv
    exigir_cotas = "--exigir-cotas" in argv
    ano, mes = mes_alvo(argv)
    tag = f"{mes:02d}/{ano}"
    conn = azure_conn()

    log(f">>> Pipeline Indicadores — mês alvo {tag}")
    log(f"    xlsx (espelho do Blob): {INDICADORES_XLSX}")
    log(f"    cotas CVM:              {COTAS_DIR / 'cotas' / 'cvm.py'}")
    log("    Resultado FO: NÃO roda aqui (fechamento provisório, rodar à parte).")
    if dry:
        log("\n[dry-run] rodaria: indicadores -> cotas CVM -> build_data indicadores"
            + ("" if skip_publish else " -> publish_hub indicadores"))
        cobertura(conn)
        return 0

    passo(1, f"Índices de mercado ({tag})")
    if not roda_indicadores(tag, conn, force):
        log("\n!! Passo 1 falhou. Abortando: as cotas USD dependem do dólar desse xlsx.")
        return 1

    passo(2, f"Cotas de fundos na CVM ({tag})")
    cotas_ok = roda_cotas(ano, mes, conn)
    if not cotas_ok:
        if exigir_cotas:
            log("\n!! Cotas indisponíveis e --exigir-cotas foi passado. Abortando.")
            return 1
        log("\n>>> Segue sem as cotas do mês: as séries de fundo ficam na última data "
            "publicada. Rodar de novo quando a CVM liberar (~dia 15).")

    passo(3, "Snapshot do hub (build_data indicadores)")
    if not roda_script_hub("build_data.py", "indicadores"):
        log("\n!! build_data falhou. Nada publicado.")
        return 1

    if skip_publish:
        log("\n>>> --skip-publish: snapshot gerado, nada enviado ao bucket.")
        cobertura(conn)
        return 0

    passo(4, "Publicação no bucket privado (publish_hub indicadores)")
    if not roda_script_hub("publish_hub.py", "indicadores"):
        log("\n!! publish_hub falhou. O hub continua com o snapshot anterior.")
        return 1

    log(f"\n>>> Concluído para {tag}."
        + ("" if cotas_ok else " ATENÇÃO: sem as cotas CVM do mês."))
    cobertura(conn)
    return 0


if __name__ == "__main__":
    sys.exit(main())
