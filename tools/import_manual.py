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
    python tools/import_manual.py manual_backoffice --secoes rotinas,saldo --gravar
    python tools/import_manual.py manual_backoffice --remover tarituba --gravar

`--gravar` recusa quando o manual do hub já tem seções: alguém pode ter editado na aba, e
regravar desfaria isso. `--forcar` só com certeza de que pode.

`--secoes` troca ou acrescenta SÓ as seções pedidas e deixa as outras como estão no hub.
Seção nova entra na posição do secoes.json. Recusa trocar seção que alguém já editou na aba
(tem `atualizado_por`), a não ser com `--forcar`. A gravação leva a guarda de versão: se a
aba gravou no meio, nada é escrito.

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


def subir(url, h, manual, pasta, imgs):
    for n in imgs:
        ctype = mimetypes.guess_type(n)[0] or "application/octet-stream"
        up = requests.post(f"{url}/storage/v1/object/{BUCKET}/{manual}/{n}",
                           data=(pasta / "img" / n).read_bytes(),
                           headers={**h, "Content-Type": ctype, "x-upsert": "true"}, timeout=120)
        if up.status_code >= 300:
            sys.exit(f"[erro] {n} -> HTTP {up.status_code}: {up.text[:300]}")
    if imgs:
        print(f"[ok] {len(imgs)} prints -> {BUCKET}/{manual}/")


def remover(manual, ids, gravar):
    """Tira seções do manual do hub, com a mesma guarda de versão. Os prints ficam no bucket."""
    url, key = env()
    h = {"Authorization": f"Bearer {key}", "apikey": key}
    r = requests.get(f"{url}/rest/v1/app_state", params={"id": f"eq.{manual}", "select": "data,updated_at"},
                     headers=h, timeout=60)
    r.raise_for_status()
    atual, versao = r.json()[0]["data"] or {}, r.json()[0]["updated_at"]
    hub = list(atual.get("secoes") or [])
    achadas = [x["id"] for x in hub if x["id"] in ids]
    faltam = [x for x in ids if x not in achadas]
    print(f"remover: {', '.join(achadas) or '(nenhuma)'}" + (f"  | não existem no hub: {', '.join(faltam)}" if faltam else ""))
    if not gravar or not achadas:
        print("Prévia. Para tirar: --gravar")
        return
    doc = {**atual, "secoes": [x for x in hub if x["id"] not in ids]}
    agora = datetime.now(timezone.utc).isoformat()
    r = requests.patch(f"{url}/rest/v1/app_state", params={"id": f"eq.{manual}", "updated_at": f"eq.{versao}"},
                       json={"data": doc, "updated_at": agora},
                       headers={**h, "Prefer": "return=representation"}, timeout=60)
    r.raise_for_status()
    if not r.json():
        sys.exit("[recusado] o manual foi gravado na aba enquanto o script rodava. Rode de novo.")
    print(f"[ok] {len(achadas)} seção(ões) removida(s); {len(doc['secoes'])} no total")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("manual", choices=MANUAIS)
    ap.add_argument("--pasta", type=Path, help="pasta de origem (padrão assets/data/manuais/<manual>)")
    ap.add_argument("--gravar", action="store_true")
    ap.add_argument("--forcar", action="store_true")
    ap.add_argument("--secoes", help="ids separados por vírgula: troca/acrescenta só estas seções")
    ap.add_argument("--remover", help="ids separados por vírgula: tira estas seções do manual do hub")
    a = ap.parse_args()
    if a.remover:
        return remover(a.manual, [x.strip() for x in a.remover.split(",") if x.strip()], a.gravar)

    pasta = a.pasta or ROOT / "assets" / "data" / "manuais" / a.manual
    titulo, secoes, imgs = carregar(pasta)
    ordem = [s["id"] for s in secoes]
    if a.secoes:
        pedidas = [x.strip() for x in a.secoes.split(",") if x.strip()]
        faltam = [x for x in pedidas if x not in ordem]
        if faltam:
            sys.exit(f"[erro] seções fora do secoes.json: {', '.join(faltam)}")
        secoes = [s for s in secoes if s["id"] in pedidas]
        imgs = sorted({n for s in secoes for n in IMG.findall(s["md"])})
    sobra = sorted({p.name for p in (pasta / "img").glob("*")} - set(imgs))
    tamanho = sum((pasta / "img" / n).stat().st_size for n in imgs)
    print(f"{a.manual}: {len(secoes)} seções, {len(imgs)} prints citados ({tamanho / 1e6:.1f} MB)")
    for s in secoes:
        print(f"  {s['id']:<14} {s['periodicidade']:<11} {len(s['md']):>6} car.  {s['titulo']}")
    if sobra and not a.secoes:
        print(f"  ({len(sobra)} arquivo(s) em img/ não citados: não sobem)")
    if not a.gravar:
        print("\nPrévia. Para subir: --gravar")
        return

    url, key = env()
    h = {"Authorization": f"Bearer {key}", "apikey": key}

    r = requests.get(f"{url}/rest/v1/app_state", params={"id": f"eq.{a.manual}", "select": "data,updated_at"},
                     headers=h, timeout=60)
    r.raise_for_status()
    if not r.json():
        sys.exit("[erro] a linha do manual não existe em app_state — rode o sql/hub_schema.sql antes.")
    atual = r.json()[0]["data"] or {}
    versao = r.json()[0]["updated_at"]
    agora = datetime.now(timezone.utc).isoformat()

    if a.secoes:
        hub = list(atual.get("secoes") or [])
        editadas = [x["id"] for x in hub if x["id"] in {s["id"] for s in secoes} and x.get("atualizado_por")]
        if editadas and not a.forcar:
            sys.exit(f"[recusado] editadas na aba: {', '.join(editadas)}. Use --forcar só se for para "
                     "sobrescrever o que foi editado lá.")
        subir(url, h, a.manual, pasta, imgs)
        for s in secoes:
            nova = {**s, "atualizado_em": agora, "atualizado_por": None}
            i = next((k for k, x in enumerate(hub) if x["id"] == s["id"]), None)
            if i is not None:
                hub[i] = nova
                continue
            # seção nova: logo depois da última anterior a ela no secoes.json que já está no hub
            antes = ordem[:ordem.index(s["id"])]
            pos = max((k + 1 for k, x in enumerate(hub) if x["id"] in antes), default=len(hub))
            hub.insert(pos, nova)
        doc = {**atual, "versao": 1, "secoes": hub}
        r = requests.patch(f"{url}/rest/v1/app_state",
                           params={"id": f"eq.{a.manual}", "updated_at": f"eq.{versao}"},
                           json={"data": doc, "updated_at": agora},
                           headers={**h, "Prefer": "return=representation"}, timeout=60)
        r.raise_for_status()
        if not r.json():
            sys.exit("[recusado] o manual foi gravado na aba enquanto o script rodava. Rode de novo.")
        print(f"[ok] app_state '{a.manual}': {len(secoes)} seção(ões) trocada(s)/acrescentada(s); "
              f"{len(hub)} no total")
        return

    if atual.get("secoes") and not a.forcar:
        sys.exit(f"[recusado] o manual no hub já tem {len(atual['secoes'])} seções (pode ter sido editado "
                 "na aba). Use --forcar só se for para sobrescrever.")

    subir(url, h, a.manual, pasta, imgs)
    doc = {"versao": 1, "titulo": titulo,
           "secoes": [{**s, "atualizado_em": agora, "atualizado_por": None} for s in secoes]}
    r = requests.patch(f"{url}/rest/v1/app_state", params={"id": f"eq.{a.manual}"},
                       json={"data": doc, "updated_at": agora},
                       headers={**h, "Prefer": "return=minimal"}, timeout=60)
    r.raise_for_status()
    print(f"[ok] app_state '{a.manual}': {len(secoes)} seções")


if __name__ == "__main__":
    main()
