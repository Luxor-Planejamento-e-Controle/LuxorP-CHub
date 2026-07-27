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
DATA = ROOT / "assets" / "data"
BUCKET = "hub-data"
# Dashboards publicáveis. Inadimplência tem PII e NÃO entra aqui enquanto o
# desenho LGPD/RBAC (ARQUITETURA.md seção 5) não estiver de pé.
DATASETS = ["indicadores", "dre"]


def env():
    cfg = dotenv_values(ROOT / ".env")
    url = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env da raiz do repo.")
    return url, key


def upload(url, key, name):
    src = DATA / f"{name}.json"
    if not src.exists():
        print(f"[skip] {src.name} não existe — rode tools/build_data.py antes.")
        return False
    body = src.read_bytes()
    r = requests.post(
        f"{url}/storage/v1/object/{BUCKET}/{name}.json",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "x-upsert": "true", "cache-control": "no-store"},
        timeout=120,
    )
    if r.status_code >= 300:
        print(f"[erro] {name}.json -> HTTP {r.status_code}: {r.text[:300]}")
        return False
    print(f"[ok] {name}.json ({len(body)//1024} KB) -> {BUCKET}/{name}.json")
    return True


def main():
    url, key = env()
    alvos = sys.argv[1:] or DATASETS
    desconhecido = [a for a in alvos if a not in DATASETS]
    if desconhecido:
        sys.exit(f"Dataset não publicável: {', '.join(desconhecido)}. Válidos: {', '.join(DATASETS)}")
    falhou = [n for n in alvos if not upload(url, key, n)]
    if falhou:
        sys.exit(f"Falha ao publicar: {', '.join(falhou)}")


if __name__ == "__main__":
    main()
