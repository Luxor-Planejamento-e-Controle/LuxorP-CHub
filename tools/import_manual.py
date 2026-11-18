"""Carga inicial de um manual da pasta "Manuais" do hub (app_state + bucket `manuais`).

Depois da carga o HUB é a fonte: o manual é editado na própria aba, por quem está em
`manual_editores` (ver sql/hub_schema.sql, seção 11). Este script existe para a primeira
subida — a do Manual de Processos do Backoffice, que era uma planilha no Drive.

A pasta de origem fica FORA do Git (repositório público): por padrão
`assets/data/manuais/<manual>/`, que o .gitignore já cobre, com

    secoes.json   {"titulo": ..., "secoes": [{"id", "titulo", "periodicidade", "arquivo"}]}
    *.md          uma seção por arquivo (markdown do assets/manuais/mn_md.js)
    img/          prints citados como ![legenda](img/<arquivo>)

Uso:
    python tools/import_manual.py manual_backoffice            # prévia: confere, não grava
    python tools/import_manual.py manual_backoffice --gravar   # sobe os prints e o texto
    python tools/import_manual.py manual_backoffice --gravar --forcar   # sobrescreve o texto

`--gravar` recusa quando o manual do hub já tem seções: alguém pode ter editado na aba, e
regravar desfaria isso. `--forcar` só com certeza de que pode.

Requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ambiente ou .env da raiz), como o
publish_hub.py.
"""
import argparse
import json
import mimetypes
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from publish_hub import env  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BUCKET = "manuais"
MANUAIS = ("manual_backoffice",)
IMG = re.compile(r"!\[[^\]]*\]\(img/([A-Za-z0-9._-]+)\)")


def carregar(pasta: Path):
    manifesto = json.loads((pasta / "secoes.json").read_text(encoding="utf-8"))
    secoes, faltando, citadas = [], [], set()
    for s in manifesto["secoes"]:
        md = (pasta / s["arquivo"]).read_text(encoding="utf-8").strip() + "\n"
        for nome in IMG.findall(md):
            citadas.add(nome)
            if not (pasta / "img" / nome).exists():
                faltando.append(f"{s['arquivo']}: img/{nome}")
        secoes.append({"id": s["id"], "titulo": s["titulo"],
                       "periodicidade": s.get("periodicidade", ""), "md": md})
    ids = [s["id"] for s in secoes]
    if len(ids) != len(set(ids)):
        sys.exit("[erro] id de seção repetido no secoes.json")
    if faltando:
        sys.exit("[erro] prints citados que não existem na pasta img/:\n  " + "\n  ".join(faltando))
    return manifesto.get("titulo", ""), secoes, sorted(citadas)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("manual", choices=MANUAIS)
    ap.add_argument("--pasta", type=Path, help="pasta de origem (padrão assets/data/manuais/<manual>)")
    ap.add_argument("--gravar", action="store_true")
    ap.add_argument("--forcar", action="store_true")
    a = ap.parse_args()

    pasta = a.pasta or ROOT / "assets" / "data" / "manuais" / a.manual
    titulo, secoes, imgs = carregar(pasta)
    sobra = sorted({p.name for p in (pasta / "img").glob("*")} - set(imgs))
    tamanho = sum((pasta / "img" / n).stat().st_size for n in imgs)
    print(f"{a.manual}: {len(secoes)} seções, {len(imgs)} prints citados ({tamanho / 1e6:.1f} MB)")
    for s in secoes:
        print(f"  {s['id']:<14} {s['periodicidade']:<11} {len(s['md']):>6} car.  {s['titulo']}")
    if sobra:
        print(f"  ({len(sobra)} arquivo(s) em img/ não citados: não sobem)")
    if not a.gravar:
        print("\nPrévia. Para subir: --gravar")
        return

    url, key = env()
    h = {"Authorization": f"Bearer {key}", "apikey": key}

    r = requests.get(f"{url}/rest/v1/app_state", params={"id": f"eq.{a.manual}", "select": "data"},
                     headers=h, timeout=60)
    r.raise_for_status()
    if not r.json():
        sys.exit("[erro] a linha do manual não existe em app_state — rode o sql/hub_schema.sql antes.")
    atual = r.json()[0]["data"] or {}
    if atual.get("secoes") and not a.forcar:
        sys.exit(f"[recusado] o manual no hub já tem {len(atual['secoes'])} seções (pode ter sido editado "
                 "na aba). Use --forcar só se for para sobrescrever.")

    for n in imgs:
        ctype = mimetypes.guess_type(n)[0] or "application/octet-stream"
        up = requests.post(f"{url}/storage/v1/object/{BUCKET}/{a.manual}/{n}",
                           data=(pasta / "img" / n).read_bytes(),
                           headers={**h, "Content-Type": ctype, "x-upsert": "true"}, timeout=120)
        if up.status_code >= 300:
            sys.exit(f"[erro] {n} -> HTTP {up.status_code}: {up.text[:300]}")
    print(f"[ok] {len(imgs)} prints -> {BUCKET}/{a.manual}/")

    agora = datetime.now(timezone.utc).isoformat()
    doc = {"versao": 1, "titulo": titulo,
           "secoes": [{**s, "atualizado_em": agora, "atualizado_por": None} for s in secoes]}
    r = requests.patch(f"{url}/rest/v1/app_state", params={"id": f"eq.{a.manual}"},
                       json={"data": doc, "updated_at": agora},
                       headers={**h, "Prefer": "return=minimal"}, timeout=60)
    r.raise_for_status()
    print(f"[ok] app_state '{a.manual}': {len(secoes)} seções")


if __name__ == "__main__":
    main()
