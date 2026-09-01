# Imagem do job "hub-indicadores": Blob -> indicadores.json -> bucket privado.
#
# Existe para o painel de Indicadores não depender da máquina do analista ligada.
# O cálculo dos índices é do financial-indicators-job (outro repo/imagem); aqui é
# só o último quilômetro, que antes rodava numa tarefa agendada do Windows.
#
# Contexto de build = raiz do repo:
#   az acr build --registry luxoracr --image hub-indicadores:latest \
#     --file tools/Dockerfile .
FROM python:3.12-slim

WORKDIR /app

COPY tools/requirements-job.txt tools/
RUN pip install --no-cache-dir -r tools/requirements-job.txt

# Só os dois scripts: build lê o Blob, publish sobe pro bucket. Nada do site.
COPY tools/build_data.py tools/publish_hub.py tools/

# build_data grava em <raiz>/assets/data; o publish lê de lá.
RUN mkdir -p assets/data

# Credenciais chegam por secret em variável de ambiente (sem .env na imagem):
#   AZURE_STORAGE_CONNECTION_STRING, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
# Encadeado com && : publish só roda se o build gerou snapshot novo.
CMD ["sh", "-c", "python tools/build_data.py indicadores && python tools/publish_hub.py indicadores"]
