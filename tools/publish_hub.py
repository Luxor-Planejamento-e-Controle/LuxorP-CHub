"""Publica os snapshots do hub no bucket PRIVADO do Supabase (`hub-data`).

Roda depois do build_data.py. Cada arquivo vira `<dashboard>.json` no bucket —
o nome importa: a policy de leitura (sql/hub_schema.sql) usa o prefixo do nome
para decidir quem pode baixar.

Requer a service_role key (ignora RLS) num .env local — NUNCA versionar:

    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=eyJ...

Uso: python tools/publish_hub.py [indicadores dre ...]
"""
import sys
from pathlib import Path

import requests
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
BUCKET = "hub-data"

# dataset -> (arquivo local, nome no bucket, content-type).
# O nome no bucket manda: a policy usa o prefixo antes do ponto pra decidir
# quem baixa (`hub_can('<prefixo>')`, ver sql/hub_schema.sql).
DATASETS = {
    "indicadores":   (ROOT / "assets/data/indicadores.json",        "indicadores.json",   "application/json"),
    "dre":           (ROOT / "assets/data/dre.json",                "dre.json",           "application/json"),
    # PII: sai do bucket privado direto pro navegador de quem tem
    # `hub_can('inadimplencia')`. Nunca vira arquivo estático no Netlify.
    "inadimplencia": (ROOT / "assets/inadimplencia/dashboard.html", "inadimplencia.html", "text/html; charset=utf-8"),
    # PII tambem (nome de cliente na tabela de detalhe das vendas).
    "vendas":        (ROOT / "assets/vendas/dashboard.html",        "vendas.html",        "text/html; charset=utf-8"),
}
# Quem gera cada arquivo local, pra mensagem de erro apontar o build certo.
GERADOR = {
    "inadimplencia": "tools/build_inadimplencia.py",
    "vendas": "tools/build_vendas.py",
}
# Datasets com PII: ficam fora do padrão e saem com aviso.
COM_PII = ("inadimplencia", "vendas")
# Padrão do publish sem argumento. Os com PII são explícitos.
PADRAO = ["indicadores", "dre"]


def env():
    cfg = dotenv_values(ROOT / ".env")
    url = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env da raiz do repo.")
    return url, key


def upload(url, key, name):
    src, dest, ctype = DATASETS[name]
    if not src.exists():
        gerador = GERADOR.get(name, "tools/build_data.py")
        print(f"[skip] {src.name} não existe — rode {gerador} antes.")
        return False
    body = src.read_bytes()
    r = requests.post(
        f"{url}/storage/v1/object/{BUCKET}/{dest}",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": ctype,
                 "x-upsert": "true", "cache-control": "no-store"},
        timeout=120,
    )
    if r.status_code >= 300:
        print(f"[erro] {dest} -> HTTP {r.status_code}: {r.text[:300]}")
        return False
    print(f"[ok] {dest} ({len(body)//1024} KB) -> {BUCKET}/{dest}")
    return True


def main():
    url, key = env()
    alvos = sys.argv[1:] or PADRAO
    if alvos == ["--all"]:
        alvos = list(DATASETS)
    desconhecido = [a for a in alvos if a not in DATASETS]
    if desconhecido:
        sys.exit(f"Dataset não publicável: {', '.join(desconhecido)}. "
                 f"Válidos: {', '.join(DATASETS)}")
    for nome in alvos:
        if nome in COM_PII:
            print(f"[aviso] {nome} contém PII. Vai pro bucket PRIVADO, visível só "
                  f"para quem tem hub_can('{nome}').")
    falhou = [n for n in alvos if not upload(url, key, n)]
    if falhou:
        sys.exit(f"Falha ao publicar: {', '.join(falhou)}")


if __name__ == "__main__":
    main()
