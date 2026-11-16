"""Traz o board "Listagem de Senhas P&C" do Trello para a aba Senhas do hub, CIFRADO.

    python tools/import_trello_senhas.py            # PRÉVIA: lê o Trello, confere a senha mestra, não grava
    python tools/import_trello_senhas.py --gravar   # grava no Supabase do .env

O que vem: listas (as arquivadas também), cards (título e descrição — é onde estão as
senhas), comentários e anexos. Tudo que é texto do board e todo arquivo é cifrado AQUI,
antes de sair da máquina, com a chave da senha mestra (mesmo formato do
assets/senhas/sh_cripto.js: PBKDF2-SHA256 + AES-256-GCM, "v1:" + base64(iv||cifra)).
O banco, o bucket `senhas` e a service_role só veem texto embaralhado.

SIGILO: o script não imprime título, descrição, comentário nem nome de anexo — só
contagens — e não grava o board em claro em lugar nenhum (nada de export no disco ou no
bucket, ao contrário do import do Kanban). Arquivo de anexo passa pela memória e sobe já
cifrado.

Senha mestra: `senha_mestra` no .env da pasta de cima do repo (ou SENHA_MESTRA no
ambiente). Na primeira gravação ela cria o cofre (sal, iterações e o verificador em
`senhas_cofre`); depois disso, rodar com outra senha é recusado — misturaria duas chaves.

Rodar de novo atualiza (cada linha é chaveada pelo id do Trello), mas recusa gravar se
alguém já criou item, comentário ou anexo no hub (desfaria o que foi feito lá), a não ser
com --forcar.

Credenciais: as mesmas do import do Kanban (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
TRELLO_API_KEY, TRELLO_TOKEN), lidas por import_trello_kanban.credenciais().
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_trello_kanban import Trello, credenciais  # noqa: E402

BOARD_NOME = "Listagem de Senhas P&C"
BUCKET = "senhas"
ITERACOES = 600_000            # PBKDF2-SHA256 (recomendação OWASP de 2023)
VERIFICADOR = "senhas-pc"      # igual ao SH_CRIPTO.VERIFICADOR
# id estável por linha do Trello: rodar de novo cai na mesma linha (upsert)
NS = uuid.UUID("5b1f2b6e-9a4e-4c3a-8f1e-3d2a7c9e5b10")


# ---------------------------------------------------------------- cifra
def chave(senha: str, sal: bytes, iteracoes: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), sal, iteracoes, 32)


def cifrar_bytes(k: bytes, dados: bytes) -> bytes:
    iv = os.urandom(12)
    return iv + AESGCM(k).encrypt(iv, dados, None)


def decifrar_bytes(k: bytes, dados: bytes) -> bytes:
    return AESGCM(k).decrypt(dados[:12], dados[12:], None)


def cifrar(k: bytes, texto: str | None) -> str:
    return "v1:" + base64.b64encode(cifrar_bytes(k, (texto or "").encode("utf-8"))).decode("ascii")


def decifrar(k: bytes, s: str) -> str:
    if not s.startswith("v1:"):
        raise ValueError("texto fora do formato cifrado")
    return decifrar_bytes(k, base64.b64decode(s[3:])).decode("utf-8")


def uid(tipo: str, trello_id: str) -> str:
    return str(uuid.uuid5(NS, f"{tipo}:{trello_id}"))


def quando_do_id(trello_id: str) -> str:
    """O id do Trello começa com o instante de criação (segundos, em hexa)."""
    return dt.datetime.fromtimestamp(int(trello_id[:8], 16), dt.timezone.utc).isoformat()


# ---------------------------------------------------------------- Supabase (service_role)
class Banco:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.cab = {"apikey": key, "Authorization": f"Bearer {key}"}
        self.s = requests.Session()

    def _ok(self, r, oque):
        if r.status_code >= 300:
            raise RuntimeError(f"{oque}: HTTP {r.status_code} {r.text[:300]}")
        return r

    def select(self, tabela, colunas="*", filtro=""):
        r = self._ok(self.s.get(f"{self.url}/rest/v1/{tabela}?select={colunas}{'&' + filtro if filtro else ''}",
                                headers=self.cab, timeout=120), f"ler {tabela}")
        return r.json()

    def upsert(self, tabela, linhas, conflito="trello_id"):
        if linhas:
            self._ok(self.s.post(f"{self.url}/rest/v1/{tabela}?on_conflict={conflito}",
                                 headers={**self.cab, "Content-Type": "application/json",
                                          "Prefer": "resolution=merge-duplicates,return=minimal"},
                                 data=json.dumps(linhas), timeout=300), f"gravar {tabela}")

    def enviar(self, caminho, corpo: bytes):
        self._ok(self.s.post(f"{self.url}/storage/v1/object/{BUCKET}/{caminho}",
                             headers={**self.cab, "Content-Type": "application/octet-stream", "x-upsert": "true"},
                             data=corpo, timeout=600), "enviar anexo")


# ---------------------------------------------------------------- Trello
def achar_board(tr: Trello) -> str:
    for org in tr.get("members/me/organizations", fields="displayName"):
        for b in tr.get(f"organizations/{org['id']}/boards", fields="name", filter="all"):
            if b["name"] == BOARD_NOME:
                return b["id"]
    for b in tr.get("members/me/boards", fields="name", filter="all"):
        if b["name"] == BOARD_NOME:
            return b["id"]
    sys.exit(f"Não achei o board {BOARD_NOME!r} com este token do Trello.")


def ler_board(tr: Trello, bid: str) -> dict:
    listas = tr.get(f"boards/{bid}/lists", filter="all", fields="name,closed,pos")
    cards = tr.get(f"boards/{bid}/cards", filter="all", fields="name,desc,closed,idList,pos,badges")
    comentarios, antes = [], None
    while True:
        p = dict(filter="commentCard", limit=1000, fields="data,date", memberCreator_fields="fullName")
        if antes:
            p["before"] = antes
        lote = tr.get(f"boards/{bid}/actions", **p)
        comentarios += lote
        if len(lote) < 1000:
            break
        antes = lote[-1]["id"]
    anexos = {}
    for c in cards:
        if (c.get("badges") or {}).get("attachments"):
            anexos[c["id"]] = tr.get(f"cards/{c['id']}/attachments", fields="name,url,isUpload,bytes,date")
    return {"listas": listas, "cards": cards, "comentarios": comentarios, "anexos": anexos}


# ---------------------------------------------------------------- principal
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gravar", action="store_true")
    ap.add_argument("--forcar", action="store_true")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    cfg = credenciais()
    senha = (cfg.get("SENHA_MESTRA") or cfg.get("senha_mestra") or "").strip()
    if not senha:
        sys.exit("Falta a senha mestra: senha_mestra no .env da pasta de cima (ou SENHA_MESTRA).")
    tr = Trello(cfg["TRELLO_API_KEY"], cfg["TRELLO_TOKEN"])
    db = Banco(cfg["SUPABASE_URL"], cfg["SUPABASE_SERVICE_ROLE_KEY"])

    # 1) cofre: o que já existe manda (a senha tem de conferir); senão nasce agora
    cofres = db.select("senhas_cofre")
    if cofres:
        cofre = cofres[0]
        k = chave(senha, base64.b64decode(cofre["sal"]), cofre["iteracoes"])
        try:
            ok = decifrar(k, cofre["verificador"]) == VERIFICADOR
        except Exception:
            ok = False
        if not ok:
            sys.exit("A senha mestra do .env NÃO confere com o cofre do hub. Nada foi gravado.")
        print("cofre: já existe, senha mestra confere")
        novo_cofre = None
    else:
        sal = os.urandom(16)
        k = chave(senha, sal, ITERACOES)
        novo_cofre = {"id": 1, "sal": base64.b64encode(sal).decode("ascii"), "iteracoes": ITERACOES,
                      "verificador": cifrar(k, VERIFICADOR)}
        print(f"cofre: não existe ainda — {'será criado' if not args.gravar else 'criando'} "
              f"(PBKDF2-SHA256, {ITERACOES:,} iterações)")

    # 2) Trello
    bid = achar_board(tr)
    b = ler_board(tr, bid)
    cards_ok = {c["id"] for c in b["cards"]}
    coments = [a for a in b["comentarios"] if (a.get("data") or {}).get("card", {}).get("id") in cards_ok]
    uploads = [(cid, a) for cid, lst in b["anexos"].items() for a in lst if a.get("isUpload")]
    links = [(cid, a) for cid, lst in b["anexos"].items() for a in lst if not a.get("isUpload")]
    print(f"Trello: {len(b['listas'])} listas ({sum(l['closed'] for l in b['listas'])} arquivadas), "
          f"{len(b['cards'])} cards ({sum(c['closed'] for c in b['cards'])} arquivados, "
          f"{sum(1 for c in b['cards'] if c['desc'].strip())} com descrição), {len(coments)} comentários, "
          f"{len(uploads)} anexos de arquivo, {len(links)} anexos de link (viram comentário)")

    # 3) trava: o que o time criou no hub não é desfeito em silêncio
    do_hub = sum(len(db.select(t, "id", "trello_id=is.null")) for t in ("senhas_itens", "senhas_comentarios", "senhas_anexos"))
    if do_hub and args.gravar and not args.forcar:
        sys.exit(f"Já há {do_hub} linha(s) criada(s) no hub: gravar de novo desfaria o que foi feito lá. "
                 "Use --forcar se for de propósito.")

    # 4) montagem (já cifrada)
    listas = [{"id": uid("lista", l["id"]), "trello_id": l["id"], "nome": cifrar(k, l["name"]),
               "pos": l["pos"], "arquivada": l["closed"]} for l in b["listas"]]
    itens = [{"id": uid("item", c["id"]), "trello_id": c["id"], "lista_id": uid("lista", c["idList"]),
              "titulo": cifrar(k, c["name"]), "conteudo": cifrar(k, c["desc"]), "pos": c["pos"],
              "arquivado": c["closed"], "criado_em": quando_do_id(c["id"])} for c in b["cards"]]
    comentarios = [{"id": uid("coment", a["id"]), "trello_id": a["id"],
                    "item_id": uid("item", a["data"]["card"]["id"]),
                    "texto": cifrar(k, a["data"].get("text") or ""),
                    "autor": (a.get("memberCreator") or {}).get("fullName"), "criado_em": a["date"]}
                   for a in coments]
    comentarios += [{"id": uid("link", a["id"]), "trello_id": "link:" + a["id"], "item_id": uid("item", cid),
                     "texto": cifrar(k, f"Link anexado no Trello: {a.get('name') or ''} {a.get('url') or ''}".strip()),
                     "autor": None, "criado_em": a.get("date") or quando_do_id(a["id"])} for cid, a in links]

    if not args.gravar:
        # prova de que a cifra volta: decifra uma amostra na memória, sem mostrar
        amostra = itens[0] if itens else None
        if amostra:
            assert decifrar(k, amostra["titulo"]) is not None
        print("\nPRÉVIA: nada gravado. Para gravar: --gravar")
        return

    # 5) gravação
    if novo_cofre:
        db.upsert("senhas_cofre", [novo_cofre], conflito="id")
    db.upsert("senhas_listas", listas)
    db.upsert("senhas_itens", itens)
    db.upsert("senhas_comentarios", comentarios)
    anexos, falhas = [], 0
    for cid, a in uploads:
        r = tr.baixar(a["url"])
        if r.status_code != 200:
            falhas += 1
            continue
        aid = uid("anexo", a["id"])
        caminho = f"{aid}.bin"
        db.enviar(caminho, cifrar_bytes(k, r.content))
        anexos.append({"id": aid, "trello_id": a["id"], "item_id": uid("item", cid),
                       "nome": cifrar(k, a.get("name") or "arquivo"), "caminho": caminho,
                       "tamanho": a.get("bytes"), "criado_em": a.get("date") or quando_do_id(a["id"])})
    db.upsert("senhas_anexos", anexos)

    # 6) conferência: contagens e uma volta da cifra no que ficou no banco
    n = {t: len(db.select(t, "id")) for t in ("senhas_listas", "senhas_itens", "senhas_comentarios", "senhas_anexos")}
    volta = db.select("senhas_itens", "titulo", "limit=1")
    if volta:
        decifrar(k, volta[0]["titulo"])            # estoura se a chave não bater
    print(f"\ngravado: {n['senhas_listas']} listas, {n['senhas_itens']} itens, "
          f"{n['senhas_comentarios']} comentários, {n['senhas_anexos']} anexos"
          + (f" — {falhas} anexo(s) não baixaram do Trello" if falhas else "") + "; a cifra volta com a senha mestra")


if __name__ == "__main__":
    main()
