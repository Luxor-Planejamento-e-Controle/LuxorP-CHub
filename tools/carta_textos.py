"""Textos da Carta Trimestral: PPTX do CEO -> arquivo de revisão -> hub (app_state 'carta').

Os textos chegam por fora (o CEO escreve no PPTX da carta), passam por revisão e
tradução, e entram no hub. Até 11/2026 isso era colado à mão em "Editar textos"; este
script faz a ponta e a volta, no MESMO formato que o editor da aba grava
(ver assets/apresentacoes/ap_deck.js, CONTEUDO):

    {"2026-Q3": {"pt": {"destaques", "atualizacoes"}, "en": {...},
                 "leituras": [{"img": "data:image/jpeg;base64,...", "pt", "en"}]}}

Fluxo:
    python tools/carta_textos.py extrair "<pptx do CEO>"      # -> assets/data/carta/<período>/
    (revisar e traduzir o textos.md dessa pasta)
    python tools/carta_textos.py gravar 2026-Q3               # prévia: confere, não grava
    python tools/carta_textos.py gravar 2026-Q3 --gravar      # grava no hub
    python tools/carta_textos.py baixar 2026-Q3               # hub -> textos.md (p/ revisar o que está lá)

`extrair` acha as páginas pelos títulos ("Destaques e Prioridades", "Atualizações do
Grupo Luxor", "O que temos lido…" — ou os do inglês), então serve tanto para o PPTX
exportado pela aba quanto para o modelo antigo do G:. O idioma sai dos títulos; num
textos.md que já existe, troca só as seções desse idioma (e as leituras, se o PPTX tem).

`gravar` recusa quando o trimestre já tem texto diferente no hub (alguém pode ter
colado na aba): `--substituir` só com certeza. A gravação leva a guarda de versão do
editor — se a aba gravou no meio, nada é escrito — e guarda uma cópia do que havia em
`hub_antes_<hora>.json` na mesma pasta.

A pasta assets/data/ é gitignored: texto da carta é conteúdo da família, e este repo é
público. Requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ambiente ou .env da raiz).
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PASTA = ROOT / "assets" / "data" / "carta"
APP_STATE = "carta"
MAX_LEITURAS = 3          # o layout desenha no máximo três (ap_layout.js, carta_texto)
ALTURA_IMG = 600          # o editor reduz a capa a 600 px de altura, JPEG 0,85

TITULOS = {
    "destaques": {"pt": "destaques e prioridades", "en": "highlights and priorities"},
    "atualizacoes": {"pt": "atualizacoes do grupo luxor", "en": "luxor group updates"},
    "lido": {"pt": "o que temos lido", "en": "what we have been reading"},
}
CAMPOS = ("destaques", "atualizacoes")
CABECALHO = (
    "<!-- Carta Trimestral {periodo}: textos para `python tools/carta_textos.py gravar {periodo}`.\n"
    "     Uma linha = um parágrafo; linha em branco é ignorada; **negrito** e *itálico* valem.\n"
    "     leituraN.img = arquivo da imagem nesta pasta. Não mude os títulos `## ...`. -->\n"
)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s).strip(" :").lower()


# --------------------------------------------------------------------------
# textos.md
# --------------------------------------------------------------------------
def chaves(n_leituras: int) -> list[str]:
    ks = [f"{c}.{l}" for c in CAMPOS for l in ("pt", "en")]
    for i in range(1, n_leituras + 1):
        ks += [f"leitura{i}.img", f"leitura{i}.pt", f"leitura{i}.en"]
    return ks


def le_md(arq: Path) -> dict[str, str]:
    secoes, atual = {}, None
    for linha in arq.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^##\s+(\S+)\s*$", linha)
        if m:
            atual = m.group(1)
            secoes[atual] = []
        elif atual:
            secoes[atual].append(linha)
    sem_html = lambda ls: [l for l in ls if not l.strip().startswith("<!--")]
    return {k: "\n".join(l.strip() for l in sem_html(v) if l.strip()) for k, v in secoes.items()}


def escreve_md(arq: Path, periodo: str, sec: dict[str, str]):
    n = max([int(m.group(1)) for k in sec for m in [re.match(r"leitura(\d+)\.", k)] if m] or [0])
    corpo = [CABECALHO.format(periodo=periodo)]
    for k in chaves(n):
        texto = sec.get(k, "")
        # parágrafo separado por linha em branco: mais fácil de revisar; o gravar junta
        corpo.append(f"## {k}\n\n" + ("\n\n".join(texto.splitlines()) + "\n" if texto else "") )
    arq.write_text("\n".join(corpo), encoding="utf-8")


# --------------------------------------------------------------------------
# extrair: PPTX -> textos.md + imagens
# --------------------------------------------------------------------------
def _formas(shapes):
    for sh in shapes:
        if sh.shape_type == 6:          # grupo
            yield from _formas(sh.shapes)
        else:
            yield sh


def _paragrafos(sh) -> str:
    """Texto do quadro, um parágrafo por linha. Negrito/itálico de trecho viram ** e *;
    se o quadro inteiro é negrito (estilo do modelo, não ênfase), não marca nada."""
    paras = [[r for r in p.runs if r.text] for p in sh.text_frame.paragraphs]
    runs = [r for p in paras for r in p if r.text.strip()]
    tudo_b = bool(runs) and all(r.font.bold for r in runs)
    tudo_i = bool(runs) and all(r.font.italic for r in runs)
    linhas = []
    for p in paras:
        partes = []
        for r in p:
            t = r.text.replace("\t", " ").replace("\u000b", " ")
            nucleo = t.strip()
            if nucleo and r.font.bold and not tudo_b:
                t = t.replace(nucleo, f"**{nucleo}**", 1)
            elif nucleo and r.font.italic and not tudo_i:
                t = t.replace(nucleo, f"*{nucleo}*", 1)
            partes.append(t)
        linha = re.sub(r"\s+", " ", "".join(partes)).strip()
        if linha:
            linhas.append(linha)
    return "\n".join(linhas)


def _titulo(sh, chave) -> str | None:
    t = norm(sh.text_frame.text)
    for lang, alvo in TITULOS[chave].items():
        if t == alvo or (chave == "lido" and t.startswith(alvo)):
            return lang
    return None


def ler_pptx(arq: Path) -> tuple[str, dict, list]:
    """-> (idioma, {destaques, atualizacoes}, [{blob, ext, texto}])"""
    from pptx import Presentation
    prs = Presentation(str(arq))
    largura = prs.slide_width
    idioma, campos, leituras = None, {}, []
    for slide in prs.slides:
        formas = list(_formas(slide.shapes))
        textos = [s for s in formas if s.has_text_frame and s.text_frame.text.strip()]
        for campo in CAMPOS:
            tit = next((s for s in textos if _titulo(s, campo)), None)
            if tit is None:
                continue
            idioma = idioma or _titulo(tit, campo)
            lido = next((s for s in textos if _titulo(s, "lido")), None)
            corpo = [s for s in textos if s is not tit and s is not lido]
            if lido is not None:
                acima = [s for s in corpo if s.top < lido.top]
                abaixo = [s for s in corpo if s.top >= lido.top]
            else:
                acima, abaixo = corpo, []
            if acima:
                campos[campo] = _paragrafos(max(acima, key=lambda s: len(s.text_frame.text)))
            if campo != "atualizacoes" or lido is None:
                continue
            # leituras: imagem grande abaixo do título + o quadro de texto da mesma altura
            fotos = []
            for s in formas:
                if s.shape_type != 13 or s.top < lido.top or s.width < largura * 0.08:
                    continue
                try:
                    fotos.append((s, s.image.blob, s.image.ext))
                except Exception:       # imagem vinculada / SVG sem blob (logo do rodapé)
                    continue
            usadas = set()
            for t in sorted(abaixo, key=lambda s: (s.top, s.left)):
                def sobrepoe(f):
                    return min(t.top + t.height, f.top + f.height) - max(t.top, f.top)
                livres = [f for f in fotos if id(f[0]) not in usadas and sobrepoe(f[0]) > 0]
                foto = max(livres, key=lambda f: sobrepoe(f[0]), default=None)
                if foto:
                    usadas.add(id(foto[0]))
                leituras.append({"blob": foto[1] if foto else None, "ext": foto[2] if foto else None,
                                 "texto": _paragrafos(t)})
            for f in fotos:              # imagem sem texto do lado também é leitura
                if id(f[0]) not in usadas:
                    leituras.append({"blob": f[1], "ext": f[2], "texto": ""})
    if not idioma:
        sys.exit("[erro] não achei 'Destaques e Prioridades' nem 'Highlights and Priorities' no PPTX.")
    return idioma, campos, leituras[:MAX_LEITURAS]


def periodo_de(arq: Path, dado: str | None) -> str:
    if dado:
        if not re.fullmatch(r"\d{4}-Q[1-4]", dado):
            sys.exit(f"[erro] período no formato AAAA-QN (ex.: 2026-Q3), não {dado!r}")
        return dado
    m = re.search(r"([1-4])Q(\d{4})", arq.name, re.I) or re.search(r"Q([1-4])[ _-]?(\d{4})", arq.name, re.I)
    if not m:
        sys.exit("[erro] não deu para tirar o trimestre do nome do arquivo — passe --periodo AAAA-QN")
    return f"{m.group(2)}-Q{m.group(1)}"


def extrair(a):
    arq = Path(a.pptx)
    periodo = periodo_de(arq, a.periodo)
    idioma, campos, leituras = ler_pptx(arq)
    pasta = PASTA / periodo
    pasta.mkdir(parents=True, exist_ok=True)
    md = pasta / "textos.md"
    sec = le_md(md) if md.exists() else {}
    for c in CAMPOS:
        if c in campos:
            sec[f"{c}.{idioma}"] = campos[c]
    if leituras:
        antigas = {k: v for k, v in sec.items() if k.startswith("leitura")}
        sec = {k: v for k, v in sec.items() if not k.startswith("leitura")}
        for i, l in enumerate(leituras, 1):
            if l["blob"]:
                nome = f"leitura{i}.{l['ext']}"
                (pasta / nome).write_bytes(l["blob"])
                sec[f"leitura{i}.img"] = nome
            sec[f"leitura{i}.{idioma}"] = l["texto"]
            outro = "en" if idioma == "pt" else "pt"
            sec[f"leitura{i}.{outro}"] = antigas.get(f"leitura{i}.{outro}", "")
    escreve_md(md, periodo, sec)
    print(f"{arq.name} -> {md.relative_to(ROOT)}  ({periodo}, {idioma.upper()})")
    for c in CAMPOS:
        print(f"  {c:<13} {len(campos.get(c, '')):>5} car." + ("" if c in campos else "  (não achado)"))
    for i, l in enumerate(leituras, 1):
        print(f"  leitura{i:<6} {len(l['texto']):>5} car.  imagem: {'sim' if l['blob'] else 'não'}")


# --------------------------------------------------------------------------
# hub
# --------------------------------------------------------------------------
def _hub():
    import requests
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from publish_hub import env
    url, key = env()
    h = {"Authorization": f"Bearer {key}", "apikey": key}
    r = requests.get(f"{url}/rest/v1/app_state", params={"id": f"eq.{APP_STATE}", "select": "data,updated_at"},
                     headers=h, timeout=60)
    r.raise_for_status()
    if not r.json():
        sys.exit("[erro] a linha 'carta' não existe em app_state — rode o sql/hub_schema.sql antes.")
    return url, h, r.json()[0]


def data_url(arq: Path) -> str:
    from PIL import Image
    im = Image.open(arq)
    if im.mode in ("RGBA", "LA", "P"):
        fundo = Image.new("RGB", im.size, "white")
        fundo.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
        im = fundo
    im = im.convert("RGB")
    k = min(1, ALTURA_IMG / im.height)
    im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def montar(periodo: str) -> dict:
    pasta = PASTA / periodo
    md = pasta / "textos.md"
    if not md.exists():
        sys.exit(f"[erro] {md.relative_to(ROOT)} não existe — rode o extrair (ou o baixar) antes.")
    sec = le_md(md)
    tri = {l: {c: sec.get(f"{c}.{l}", "") for c in CAMPOS} for l in ("pt", "en")}
    tri["leituras"] = []
    n = 1
    while any(f"leitura{n}.{x}" in sec for x in ("img", "pt", "en")):
        img = sec.get(f"leitura{n}.img", "").strip()
        if img and not (pasta / img).exists():
            sys.exit(f"[erro] leitura{n}.img: {img} não está em {pasta.relative_to(ROOT)}")
        item = {"img": data_url(pasta / img) if img else None,
                "pt": sec.get(f"leitura{n}.pt", ""), "en": sec.get(f"leitura{n}.en", "")}
        if item["img"] or item["pt"] or item["en"]:
            tri["leituras"].append(item)
        n += 1
    if len(tri["leituras"]) > MAX_LEITURAS:
        sys.exit(f"[erro] {len(tri['leituras'])} leituras; a página desenha no máximo {MAX_LEITURAS}.")
    return tri


def resumo(tri: dict) -> list[str]:
    out = []
    for l in ("pt", "en"):
        out.append(f"  {l.upper()}  " + "  ".join(f"{c} {len(tri.get(l, {}).get(c) or ''):>5} car." for c in CAMPOS))
    for i, x in enumerate(tri.get("leituras") or [], 1):
        out.append(f"  leitura{i}  PT {len(x.get('pt') or ''):>4} car.  EN {len(x.get('en') or ''):>4} car.  "
                   f"imagem {'sim' if x.get('img') else 'não'}")
    return out


def gravar(a):
    import requests
    periodo = periodo_de(Path(""), a.periodo)
    tri = montar(periodo)
    vazios = [f"{c}.{l}" for l in ("pt", "en") for c in CAMPOS if not tri[l][c]]
    vazios += [f"leitura{i}.{l}" for i, x in enumerate(tri["leituras"], 1) for l in ("pt", "en") if not x[l]]
    print(f"{periodo}: textos.md")
    print("\n".join(resumo(tri)))
    if vazios:
        print(f"  vazios (saem como 'texto ainda não colado'): {', '.join(vazios)}")

    url, h, linha = _hub()
    doc = linha["data"] or {}
    trimestres = dict(doc.get("trimestres") or {})
    no_hub = trimestres.get(periodo)
    if no_hub == tri:
        print("O hub já tem exatamente isso. Nada a fazer.")
        return
    if no_hub:
        print("No hub hoje:")
        print("\n".join(resumo(no_hub)))
    if not a.gravar:
        print("\nPrévia. Para gravar: --gravar" + (" --substituir" if no_hub else ""))
        return
    if no_hub and not a.substituir:
        sys.exit(f"[recusado] {periodo} já tem texto no hub (pode ter sido colado na aba). "
                 "Rode `baixar` para revisar o que está lá, ou use --substituir.")

    agora = datetime.now(timezone.utc)
    copia = PASTA / periodo / f"hub_antes_{agora.astimezone():%Y%m%d_%H%M%S}.json"
    copia.write_text(json.dumps(linha, ensure_ascii=False), encoding="utf-8")
    trimestres[periodo] = tri
    r = requests.patch(f"{url}/rest/v1/app_state",
                       params={"id": f"eq.{APP_STATE}", "updated_at": f"eq.{linha['updated_at']}"},
                       json={"data": {**doc, "versao": 1, "trimestres": trimestres},
                             "updated_at": agora.isoformat()},
                       headers={**h, "Prefer": "return=representation"}, timeout=60)
    r.raise_for_status()
    if not r.json():
        sys.exit("[recusado] a carta foi gravada na aba enquanto o script rodava. Rode de novo.")
    print(f"[ok] {periodo} gravado no hub (cópia do anterior: {copia.relative_to(ROOT)}). "
          "Na aba, F5 para ver.")


def baixar(a):
    periodo = periodo_de(Path(""), a.periodo)
    _, _, linha = _hub()
    tri = ((linha["data"] or {}).get("trimestres") or {}).get(periodo)
    if not tri:
        sys.exit(f"[erro] o hub não tem texto de {periodo}.")
    pasta = PASTA / periodo
    pasta.mkdir(parents=True, exist_ok=True)
    md = pasta / "textos.md"
    if md.exists() and not a.substituir:
        sys.exit(f"[recusado] {md.relative_to(ROOT)} já existe (pode ter revisão não gravada). "
                 "Use --substituir para trocar pelo que está no hub.")
    sec = {f"{c}.{l}": (tri.get(l) or {}).get(c, "") for l in ("pt", "en") for c in CAMPOS}
    for i, x in enumerate(tri.get("leituras") or [], 1):
        m = re.match(r"data:image/(\w+);base64,(.*)", x.get("img") or "", re.S)
        if m:
            nome = f"leitura{i}.{'jpg' if m.group(1) == 'jpeg' else m.group(1)}"
            (pasta / nome).write_bytes(base64.b64decode(m.group(2)))
            sec[f"leitura{i}.img"] = nome
        sec[f"leitura{i}.pt"], sec[f"leitura{i}.en"] = x.get("pt", ""), x.get("en", "")
    escreve_md(md, periodo, sec)
    print(f"hub -> {md.relative_to(ROOT)}")
    print("\n".join(resumo(tri)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extrair", help="PPTX da carta -> assets/data/carta/<período>/textos.md")
    e.add_argument("pptx")
    e.add_argument("--periodo", help="AAAA-QN; padrão: tirado do nome do arquivo (…_3Q2026…)")
    g = sub.add_parser("gravar", help="textos.md -> hub (sem --gravar é só prévia)")
    g.add_argument("periodo")
    g.add_argument("--gravar", action="store_true")
    g.add_argument("--substituir", action="store_true", help="troca texto que já está no hub")
    b = sub.add_parser("baixar", help="hub -> textos.md, para revisar o que está lá")
    b.add_argument("periodo")
    b.add_argument("--substituir", action="store_true", help="troca o textos.md que já existe")
    a = ap.parse_args()
    {"extrair": extrair, "gravar": gravar, "baixar": baixar}[a.cmd](a)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
