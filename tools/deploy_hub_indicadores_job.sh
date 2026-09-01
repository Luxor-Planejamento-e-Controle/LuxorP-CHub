#!/usr/bin/env bash
# Cria (ou atualiza) o Container App Job "hub-indicadores-job": Blob ->
# indicadores.json -> bucket privado do Supabase.
#
# Por que existe: o cálculo dos índices já era automático no Azure
# (financial-indicators-job, cron 11:00 UTC), mas a REPUBLICAÇÃO do snapshot que
# o painel lê rodava numa tarefa agendada do Windows — logo, só com a máquina
# ligada, logada e sem ninguém fechar a janela do console. Em 13/08, 17/08 e
# 01/09/2026 essa tarefa morreu com CTRL+C e o painel ficou com dado velho.
#
# Roda 30 min depois do job de índices, nos mesmos dias (1-3 e 5-16).
#
# Credenciais: lidas dos .env locais na hora de rodar; nada fica no repo. São
# gravadas como secret do job e referenciadas por secretref.
#
# Uso:  bash tools/deploy_hub_indicadores_job.sh
#
# Idempotente: se o az morrer com ConnectionReset no meio (acontece nesta rede),
# rodar de novo e seguro - ele checa se o job existe antes e vira update.
# Pré:  az login feito, e a imagem já no ACR:
#         az acr build --registry luxoracr --image hub-indicadores:latest \
#           --file tools/Dockerfile .
set -euo pipefail

JOB=hub-indicadores-job
RG=rg-luxor
ENV_NOME=luxor-env
JOB_IRMAO=financial-indicators-job   # de onde sai o ID do environment
IMAGE=luxoracr.azurecr.io/hub-indicadores:latest
CRON="30 11 1-3,5-16 * *"

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIN_ENV="${FIN_ENV:-$HUB_DIR/../FinancialIndicators/.env}"

le_env() {   # le_env <arquivo> <chave>
  grep -m1 "^$2=" "$1" | cut -d= -f2- | tr -d '\r"'
}

CONN="$(le_env "$FIN_ENV" AZURE_STORAGE_CONNECTION_STRING)"
SUPA_URL="$(le_env "$HUB_DIR/.env" SUPABASE_URL)"
SUPA_KEY="$(le_env "$HUB_DIR/.env" SUPABASE_SERVICE_ROLE_KEY)"

for par in "CONN:$CONN" "SUPA_URL:$SUPA_URL" "SUPA_KEY:$SUPA_KEY"; do
  [ -n "${par#*:}" ] || { echo "!! Falta ${par%%:*} nos .env. Abortado." >&2; exit 1; }
done
echo ">>> Credenciais lidas (conn ${#CONN}, url ${#SUPA_URL}, key ${#SUPA_KEY} chars)."

ACR_PW="$(az acr credential show -n luxoracr --query 'passwords[0].value' -o tsv | tr -d '\r')"

# Environment pelo ID COMPLETO, nao pelo nome: o create resolvendo nome -> ID
# falha com "does not exist" quando a chamada de lookup toma ConnectionReset
# (acontece nesta rede). O ID sai do job irmao, que ja roda no mesmo
# environment - assim tambem nao ha subscription cravada no script.
ENV_ID="$(az containerapp job show -n "$JOB_IRMAO" -g "$RG" \
            --query properties.environmentId -o tsv 2>/dev/null | tr -d '\r')"
if [ -z "$ENV_ID" ]; then
  echo ">>> Nao deu pra ler o environment do $JOB_IRMAO; caindo pro nome '$ENV_NOME'."
  ENV_ID="$ENV_NOME"
else
  echo ">>> Environment: ${ENV_ID##*/}"
fi

if az containerapp job show -n "$JOB" -g "$RG" >/dev/null 2>&1; then
  echo ">>> Job existe: atualizando imagem, cron e secrets."
  az containerapp job secret set -n "$JOB" -g "$RG" \
    --secrets azure-conn="$CONN" supa-url="$SUPA_URL" supa-key="$SUPA_KEY" -o none
  az containerapp job update -n "$JOB" -g "$RG" \
    --image "$IMAGE" --cron-expression "$CRON" -o none
else
  echo ">>> Criando o job."
  az containerapp job create -n "$JOB" -g "$RG" \
    --environment "$ENV_ID" \
    --trigger-type Schedule \
    --cron-expression "$CRON" \
    --replica-timeout 900 \
    --replica-retry-limit 1 \
    --cpu 0.5 --memory 1Gi \
    --image "$IMAGE" \
    --registry-server luxoracr.azurecr.io \
    --registry-username luxoracr \
    --registry-password "$ACR_PW" \
    --secrets azure-conn="$CONN" supa-url="$SUPA_URL" supa-key="$SUPA_KEY" \
    --env-vars \
      AZURE_STORAGE_CONNECTION_STRING=secretref:azure-conn \
      SUPABASE_URL=secretref:supa-url \
      SUPABASE_SERVICE_ROLE_KEY=secretref:supa-key \
    -o none
fi

echo ">>> Pronto. Teste seco (roda agora, fora do cron):"
echo "      az containerapp job start -n $JOB -g $RG"
echo ">>> Execuções e status:"
echo "      az containerapp job execution list -n $JOB -g $RG -o table"
