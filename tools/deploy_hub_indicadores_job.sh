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
# Idempotente: se algo falhar no meio, rodar de novo é seguro — ele checa se o
# job existe antes e vira update.
#
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

# Sem isso o az CLI no Windows quebra com UnicodeEncodeError (cp1252) ao imprimir
# log/erro com acento, e o erro real se perde.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1
export AZURE_CORE_NO_COLOR=true

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIN_ENV="${FIN_ENV:-$HUB_DIR/../FinancialIndicators/.env}"
ERRO_TMP="$(mktemp)"
trap 'rm -f "$ERRO_TMP"' EXIT

# Chamadas ARM nesta rede tomam ConnectionReset de vez em quando (o
# `containerapp env list` falha reproduzível). Retry e, se esgotar, MOSTRA o
# stderr — a versão anterior deste script suprimia e morria calada no set -e.
az_try() {
  local tentativa=0 saida rc
  while :; do
    tentativa=$((tentativa + 1))
    if saida="$(az "$@" 2>"$ERRO_TMP")"; then
      printf '%s' "$saida"
      return 0
    fi
    rc=$?
    if [ "$tentativa" -ge 3 ]; then
      echo "!! 'az $1 $2' falhou (rc=$rc) após $tentativa tentativas:" >&2
      sed 's/^/     /' "$ERRO_TMP" >&2
      return "$rc"
    fi
    echo "   (tentativa $tentativa falhou; repetindo em 5s)" >&2
    sleep 5
  done
}

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

echo ">>> Senha do ACR..."
ACR_PW="$(az_try acr credential show -n luxoracr --query 'passwords[0].value' -o tsv | tr -d '\r')"

# Environment pelo ID COMPLETO, não pelo nome: o create resolvendo nome -> ID já
# devolveu "does not exist" quando o lookup tomou ConnectionReset. O ID sai do
# job irmão, que roda no mesmo environment — sem subscription cravada aqui.
echo ">>> Environment (via $JOB_IRMAO)..."
ENV_ID="$(az_try containerapp job show -n "$JOB_IRMAO" -g "$RG" \
            --query properties.environmentId -o tsv | tr -d '\r')" || ENV_ID=""
if [ -z "$ENV_ID" ]; then
  echo ">>> Não deu pra ler o environment do $JOB_IRMAO; caindo pro nome '$ENV_NOME'."
  ENV_ID="$ENV_NOME"
else
  echo "    ${ENV_ID##*/}"
fi

if az containerapp job show -n "$JOB" -g "$RG" >/dev/null 2>&1; then
  echo ">>> Job existe: atualizando imagem, cron e secrets."
  az_try containerapp job secret set -n "$JOB" -g "$RG" \
    --secrets azure-conn="$CONN" supa-url="$SUPA_URL" supa-key="$SUPA_KEY" -o none
  az_try containerapp job update -n "$JOB" -g "$RG" \
    --image "$IMAGE" --cron-expression "$CRON" -o none
else
  echo ">>> Criando o job."
  # --parallelism/--replica-completion-count explícitos: sem eles esta versão do
  # CLI manda 0 e o ARM recusa com InvalidTriggerAttribute.
  az_try containerapp job create -n "$JOB" -g "$RG" \
    --environment "$ENV_ID" \
    --trigger-type Schedule \
    --cron-expression "$CRON" \
    --replica-timeout 900 \
    --replica-retry-limit 1 \
    --parallelism 1 \
    --replica-completion-count 1 \
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

# Confere o que ficou de fato no Azure: um create que morre no meio pode deixar
# o job sem cron ou sem parallelism.
echo ">>> Configuração final no Azure:"
az_try containerapp job show -n "$JOB" -g "$RG" \
  --query "{nome:name, imagem:properties.template.containers[0].image, cron:properties.configuration.scheduleTriggerConfig.cronExpression, paralelismo:properties.configuration.parallelism, estado:properties.provisioningState}" \
  -o yaml

echo ">>> Teste seco (roda agora, fora do cron):"
echo "      az containerapp job start -n $JOB -g $RG"
echo ">>> Execuções e status:"
echo "      az containerapp job execution list -n $JOB -g $RG -o table"
