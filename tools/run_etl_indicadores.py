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

Sai sem fazer nada quando o mês já está completo no state do Blob, as cotas já
cobrem o fim do mês e o snapshot publicado saiu desse mesmo dado — caso da maioria
dos dias da janela de agendamento, em que nada foi liberado. `--force` ignora essa
checagem. Qualquer incerteza (erro de rede, marcador ausente) roda normalmente.

Uso:
    python tools/run_etl_indicadores.py                 # último mês fechado
    python tools/run_etl_indicadores.py 07/2026         # mês específico
    python tools/run_etl_indicadores.py --force         # roda mesmo sem novidade
    python tools/run_etl_indicadores.py --dry-run       # só mostra o plano
    python tools/run_etl_indicadores.py --skip-publish   # build sem publicar
    python tools/run_etl_indicadores.py --exigir-cotas   # aborta se a CVM não tem o mês

Passo 1 interrompido não segura mais o painel: se o Blob já cobre o fim do mês
(o Container App Job escreve os índices lá), o pipeline pula as cotas e ainda
republica o snapshot — e sai 1 para o resultado da tarefa denunciar o passo
que morreu. Sem cobertura no Blob, aborta como antes.

Exit codes: 0 = ok, 1 = falha em algum passo (painel pode ter sido republicado
mesmo assim — a última linha do log diz).
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
STATE_BLOB = f"{BLOB_PREFIX}/pipeline_state.json"

# Assinatura do dado que gerou o snapshot publicado. Fica em assets/data/, que é
# gitignored. Serve pra distinguir "mês completo e já publicado" (não roda) de
# "mês completo mas o snapshot é de antes" (roda).
MARCADOR = ROOT / "assets/data/.etl_indicadores_publicado.json"


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


# --- Curto-circuito: mês completo e já publicado ----------------------------

def _blob_bytes(bsc, path):
    bc = bsc.get_blob_client(BLOB_CONTAINER, path)
    return bc.download_blob().readall() if bc.exists() else None


def _assinatura(tag, ind_bytes, cotas_bytes):
    """Identidade do dado: o mês + o hash dos dois parquets.

    Hash do CONTEÚDO, não `last_modified`: o orquestrador sobe o parquet até em
    run no-op, então a data de modificação muda todo dia e nunca casaria. md5
    aqui é só detecção de mudança, não tem papel de segurança.
    """
    import hashlib
    return {
        "mes": tag,
        "indicadores": hashlib.md5(ind_bytes).hexdigest(),
        "cotas": hashlib.md5(cotas_bytes).hexdigest(),
    }


def nada_a_fazer(conn, ano, mes):
    """Motivo do skip, ou None se tem trabalho.

    Os dias de execução são uma JANELA (o CPI sai entre o dia 10 e o 13, o IPCA
    entre 9 e 11, as cotas a partir do 5º dia útil), então a maioria dos runs cai
    num dia em que nada foi liberado. Sem essa checagem eles reconstroem e
    republicam um snapshot idêntico.

    Só pula quando as três coisas valem: o mês está `complete` no state do Blob,
    as cotas já cobrem o fim do mês, e o snapshot publicado saiu exatamente
    desses dois parquets. Qualquer dúvida (erro de rede, marcador ausente) roda.
    """
    import json
    tag = f"{mes:02d}/{ano}"
    try:
        import pandas as pd
        from azure.storage.blob import BlobServiceClient
        bsc = BlobServiceClient.from_connection_string(conn)

        state = json.loads(
            bsc.get_blob_client(BLOB_CONTAINER, STATE_BLOB).download_blob().readall())
        minfo = state.get("months", {}).get(tag) or {}
        if not minfo.get("complete"):
            return None   # ainda falta indicador: roda

        ind_bytes = _blob_bytes(bsc, IND_BLOB)
        cotas_bytes = _blob_bytes(bsc, QUOTAS_BLOB)
        if ind_bytes is None or cotas_bytes is None:
            return None

        dfq = pd.read_parquet(io.BytesIO(cotas_bytes))
        cobertura_cotas = pd.to_datetime(dfq["DATA"], errors="coerce").max()
        if pd.isna(cobertura_cotas) or cobertura_cotas.date() < fim_do_mes(ano, mes):
            return None

        if not MARCADOR.exists():
            return None
        atual = _assinatura(tag, ind_bytes, cotas_bytes)
        if json.loads(MARCADOR.read_text(encoding="utf-8")) != atual:
            return None
        return (f"{tag} está completo no Blob, as cotas cobrem o mês e o snapshot "
                f"publicado saiu desse mesmo dado (indicadores "
                f"{atual['indicadores'][:12]}, cotas {atual['cotas'][:12]}).")
    except Exception as e:
        log(f"!! Não deu pra checar se há novidade ({e}). Vai rodar por garantia.")
        return None


def blob_cobre_mes(conn, ano, mes) -> bool:
    """O parquet de indicadores no Blob já alcança o fim do mês alvo?

    Serve para decidir se vale republicar o snapshot mesmo com o passo 1 falhado:
    o build/publish lê o Blob, que é a cópia autoritativa. Em caso de dúvida
    devolve False — republicar com dado velho é pior que não republicar.
    """
    try:
        import pandas as pd
        from azure.storage.blob import BlobServiceClient
        bsc = BlobServiceClient.from_connection_string(conn)
        ind_bytes = _blob_bytes(bsc, IND_BLOB)
        if ind_bytes is None:
            return False
        df = pd.read_parquet(io.BytesIO(ind_bytes))
        fim = pd.to_datetime(df["Data"], errors="coerce").max()
        return pd.notna(fim) and fim.date() >= fim_do_mes(ano, mes)
    except Exception as e:
        log(f"!! Não deu pra checar a cobertura do Blob ({e}).")
        return False


def grava_marcador(conn, ano, mes):
    """Registra de qual dado saiu o snapshot que acabou de ser publicado."""
    import json
    try:
        from azure.storage.blob import BlobServiceClient
        bsc = BlobServiceClient.from_connection_string(conn)
        ind_bytes = _blob_bytes(bsc, IND_BLOB)
        cotas_bytes = _blob_bytes(bsc, QUOTAS_BLOB)
        if ind_bytes is None or cotas_bytes is None:
            return
        atual = _assinatura(f"{mes:02d}/{ano}", ind_bytes, cotas_bytes)
        MARCADOR.parent.mkdir(parents=True, exist_ok=True)
        MARCADOR.write_text(json.dumps(atual, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        log(f">>> Marcador gravado: {MARCADOR.name} "
            f"(indicadores {atual['indicadores'][:12]}, cotas {atual['cotas'][:12]}).")
    except Exception as e:
        log(f"!! AVISO: não gravei o marcador ({e}). O próximo run republica.")


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
    motivo_skip = None if force else nada_a_fazer(conn, ano, mes)

    if dry:
        if motivo_skip:
            log(f"\n[dry-run] NÃO rodaria: {motivo_skip}")
        else:
            log("\n[dry-run] rodaria: indicadores -> cotas CVM -> build_data indicadores"
                + ("" if skip_publish else " -> publish_hub indicadores"))
        cobertura(conn)
        return 0

    if motivo_skip:
        log(f"\n>>> Nada a fazer: {motivo_skip}")
        log(">>> Nenhum passo executado. Use --force pra republicar de qualquer jeito.")
        return 0

    passo(1, f"Índices de mercado ({tag})")
    passo1_ok = roda_indicadores(tag, conn, force)
    if not passo1_ok:
        # Pode ter morrido por interrupção (janela do agendador fechada) sem
        # que faltasse dado: o Container App Job já escreve os índices no Blob.
        # Nesse caso o painel PODE ser republicado — build/publish leem o Blob,
        # não o xlsx do Drive. As cotas ficam de fora porque a cota USD divide
        # pelo dólar do xlsx espelho, que sem o passo 1 pode estar atrasado.
        if not blob_cobre_mes(conn, ano, mes):
            log("\n!! Passo 1 falhou e o Blob não cobre o fim do mês. "
                "Abortando: sem o dólar do fechamento não há o que publicar.")
            return 1
        log("\n!! Passo 1 falhou, MAS o Blob já cobre o fim do mês (o job "
            "do Azure escreveu os índices). Segue e republica o painel do Blob.")
        log("   Cotas do mês ficam de fora: a cota USD depende do dólar no xlsx "
            "espelho, e sem o passo 1 ele pode estar atrasado.")

    passo(2, f"Cotas de fundos na CVM ({tag})")
    if passo1_ok:
        cotas_ok = roda_cotas(ano, mes, conn)
    else:
        cotas_ok = False
        log(">>> Pulado: sem o passo 1 o dólar do xlsx espelho não é confiável, "
            "e a cota USD sai dele.")
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
    if cotas_ok:
        # Só marca quando o mês saiu inteiro: sem as cotas o run seguinte tem
        # trabalho de verdade e não pode ser pulado.
        grava_marcador(conn, ano, mes)

    log(f"\n>>> Concluído para {tag}."
        + ("" if cotas_ok else " ATENÇÃO: sem as cotas CVM do mês."))
    cobertura(conn)
    if not passo1_ok:
        # Painel republicado, mas um passo falhou: sai 1 para o resultado da
        # tarefa agendada denunciar, em vez de passar por run limpo.
        log(">>> Painel republicado a partir do Blob, mas o passo 1 falhou: "
            "sai 1 de propósito. Rodar de novo para fechar índices e cotas.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
