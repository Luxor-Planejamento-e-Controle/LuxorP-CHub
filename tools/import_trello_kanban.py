"""Traz o board "Kanban Planejamento, Controle e Concierge" do Trello para o Kanban do hub.

Copia TUDO, inclusive o arquivado: listas (as arquivadas também), cards abertos e
arquivados, etiquetas, membros de cada card, checklists e itens, comentários, anexos
(os arquivos, baixados do Trello e guardados no bucket privado `kanban`) e o histórico
de atividade. O export bruto do Trello também vai para o bucket
(`_trello/export-AAAA-MM-DD.json`): o que não virou coluna continua guardado.

Destino: as tabelas `kanban_*` da seção 8 do sql/hub_schema.sql — rodar o schema antes.

    python tools/import_trello_kanban.py              # PRÉVIA: baixa, confere e não grava
    python tools/import_trello_kanban.py --gravar     # grava no Supabase do .env

    --dump ARQ    usa um export já baixado (o JSON que a prévia salva) em vez da API
    --cache DIR   onde guardar os anexos baixados (padrão: fora do repo, em
                  ~/.cache/hub_kanban — são arquivos reais e o repo é público)
    --mapa ARQ    JSON {"usuario_do_trello": "email@..."} para casar alguém que o
                  nome não casou. Fica fora do repo, como o .env.
    --forcar      grava mesmo com o board já em uso no hub (ver abaixo)

Credenciais (variável de ambiente ou .env da raiz do repo; o Trello também é procurado
no .env da pasta de cima, onde as rotinas do P&C já guardam o token):

    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY     a service_role ignora a RLS
    TRELLO_API_KEY, TRELLO_TOKEN                leitura do board e download dos anexos

RODAR DE NOVO É SEGURO enquanto o time ainda usa o Trello: cada linha importada é
chaveada pelo id do Trello (`trello_id`), então a segunda rodada atualiza em vez de
duplicar, e o que foi apagado no Trello entre as rodadas sai do hub. É assim que se faz
a virada: importar agora para conferir, importar de novo no dia em que o time passa a
usar o hub.

Depois da virada, NÃO: a rodada espelha o Trello e desfaria o que o time fez no hub.
Por isso a gravação recusa quando já existe card, comentário, anexo ou checklist criado
no hub (trello_id nulo), a não ser com --forcar.

Membros: cada pessoa do Trello é casada com um login do hub (`allowed_users`) pelo nome,
sem acento e sem pontuação — primeiro o nome completo, depois o primeiro nome, e só
quando há UM candidato. Quem não casa (gente que saiu, a conta "Grupo Luxor") entra sem
e-mail: aparece no histórico e nos cards antigos, mas não loga. A prévia mostra o
casamento antes de gravar.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import mimetypes
import os
import re
import sys
import time
import unicodedata
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote, unquote

import requests
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
BOARD_ID = "660e0d7a0059f4ca319228f7"
BOARD_NOME = "Kanban Planejamento, Controle e Concierge"
BUCKET = "kanban"
TRELLO = "https://api.trello.com/1"
# ids estáveis: a mesma linha do Trello gera sempre o mesmo uuid, então a segunda
# rodada atualiza a linha em vez de criar outra (e os vínculos entre tabelas batem
# sem precisar ler nada de volta)
NS = uuid.UUID("7d1c3f1e-2b5a-4f43-9a51-6b0e3c5d2a10")

# Eventos do Trello que viram histórico. Os comentários não entram aqui: estão em
# kanban_comentarios. Mudança só de posição (`pos`), de "visto pelo criador" e de capa
# fica de fora — o próprio Trello não mostra isso para ninguém — mas continua no export.
IGNORAR_UPDATE = {"pos", "dateViewedByCreator", "idAttachmentCover", "cover",
                  "dueReminder", "manualCoverAttachment"}


def uid(tipo: str, trello_id: str) -> str:
    return str(uuid.uuid5(NS, f"{tipo}:{trello_id}"))


def data_do_id(trello_id: str) -> str:
    """O id do Trello é um ObjectId: os 8 primeiros hex são o instante de criação."""
    seg = int(trello_id[:8], 16)
    return dt.datetime.fromtimestamp(seg, dt.timezone.utc).isoformat()


def normal(s: str) -> str:
    """'Maurício' e 'Mauricio. Mesquita' -> 'mauricio' e 'mauricio mesquita'."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def nome_seguro(nome: str) -> str:
    """Nome de arquivo aceito pelo Storage. O nome original fica na linha do anexo."""
    base = unicodedata.normalize("NFKD", nome or "arquivo").encode("ascii", "ignore").decode()
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "arquivo"
    if len(base) > 120:
        raiz, ext = os.path.splitext(base)
        base = raiz[:120 - len(ext)] + ext
    return base


# --------------------------------------------------------------------------
# credenciais
# --------------------------------------------------------------------------
def credenciais():
    cfg = {**dotenv_values(ROOT.parent / ".env"), **dotenv_values(ROOT / ".env"), **os.environ}
    faltam = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TRELLO_API_KEY", "TRELLO_TOKEN")
              if not cfg.get(k)]
    if faltam:
        sys.exit("Faltam: " + ", ".join(faltam) + " (variável de ambiente ou .env).")
    return cfg


class Trello:
    def __init__(self, key, token):
        self.auth = {"key": key, "token": token}
        # download de anexo enviado ao Trello exige o token no cabeçalho, não na URL
        self.cab = {"Authorization": f'OAuth oauth_consumer_key="{key}", oauth_token="{token}"'}
        self.s = requests.Session()

    def get(self, caminho, **params):
        for tentativa in range(6):
            r = self.s.get(f"{TRELLO}/{caminho}", params={**self.auth, **params}, timeout=120)
            if r.status_code == 429:
                time.sleep(5 * (tentativa + 1))
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"Trello recusou {caminho} (429 seguidos)")

    def baixar(self, url):
        url = url.replace("https://trello.com/1/", f"{TRELLO}/")
        for tentativa in range(6):
            r = self.s.get(url, headers=self.cab, timeout=300)
            if r.status_code == 429:
                time.sleep(5 * (tentativa + 1))
                continue
            return r
        return r

    def exportar(self):
        b = BOARD_ID
        board = self.get(f"boards/{b}", fields="all", memberships="all")
        if board["name"] != BOARD_NOME:
            sys.exit(f"O board {b} agora se chama {board['name']!r}, e não {BOARD_NOME!r}. "
                     "Confira antes de importar.")
        acoes, antes = [], None
        while True:
            p = dict(filter="all", limit=1000, memberCreator_fields="fullName,username",
                     member_fields="fullName,username")
            if antes:
                p["before"] = antes
            pagina = self.get(f"boards/{b}/actions", **p)
            acoes += pagina
            if len(pagina) < 1000:
                break
            antes = pagina[-1]["id"]
        return {
            "exportado_em": dt.datetime.now(dt.timezone.utc).isoformat(),
            "board": board,
            "lists": self.get(f"boards/{b}/lists", filter="all", fields="all"),
            "cards": self.get(f"boards/{b}/cards/all", fields="all", attachments="true",
                              attachment_fields="all", checklists="all", checkItemStates="true",
                              customFieldItems="true", members="true",
                              member_fields="fullName,username", stickers="true", pluginData="true"),
            "checklists": self.get(f"boards/{b}/checklists", checkItem_fields="all", fields="all",
                                   filter="all"),
            "labels": self.get(f"boards/{b}/labels", limit=1000, fields="all"),
            "members": self.get(f"boards/{b}/members", fields="fullName,username,initials"),
            "customFields": self.get(f"boards/{b}/customFields"),
            "actions": acoes,
        }


class Supabase:
    def __init__(self, url, key):
        self.url = url.rstrip("/")
        self.cab = {"apikey": key, "Authorization": f"Bearer {key}"}
        self.s = requests.Session()

    def _ok(self, r, o_que):
        if r.status_code >= 300:
            raise RuntimeError(f"{o_que}: HTTP {r.status_code} {r.text[:400]}")
        return r

    def select(self, tabela, colunas="*", filtro=""):
        linhas, ini = [], 0
        while True:
            r = self._ok(self.s.get(
                f"{self.url}/rest/v1/{tabela}?select={colunas}{'&' + filtro if filtro else ''}",
                headers={**self.cab, "Range": f"{ini}-{ini + 999}"}, timeout=120), f"ler {tabela}")
            lote = r.json()
            linhas += lote
            if len(lote) < 1000:
                return linhas
            ini += 1000

    def upsert(self, tabela, linhas, conflito="trello_id", lote=500):
        for i in range(0, len(linhas), lote):
            self._ok(self.s.post(
                f"{self.url}/rest/v1/{tabela}?on_conflict={conflito}",
                headers={**self.cab, "Content-Type": "application/json",
                         "Prefer": "resolution=merge-duplicates,return=minimal"},
                data=json.dumps(linhas[i:i + lote]), timeout=300), f"gravar {tabela}")

    def inserir(self, tabela, linhas, lote=500):
        for i in range(0, len(linhas), lote):
            self._ok(self.s.post(
                f"{self.url}/rest/v1/{tabela}",
                headers={**self.cab, "Content-Type": "application/json", "Prefer": "return=minimal"},
                data=json.dumps(linhas[i:i + lote]), timeout=300), f"gravar {tabela}")

    def patch(self, tabela, filtro, corpo):
        self._ok(self.s.patch(f"{self.url}/rest/v1/{tabela}?{filtro}",
                              headers={**self.cab, "Content-Type": "application/json",
                                       "Prefer": "return=minimal"},
                              data=json.dumps(corpo), timeout=120), f"atualizar {tabela}")

    def apagar(self, tabela, coluna, valores, lote=100):
        valores = list(valores)
        for i in range(0, len(valores), lote):
            parte = ",".join(valores[i:i + lote])
            self._ok(self.s.delete(f"{self.url}/rest/v1/{tabela}?{coluna}=in.({parte})",
                                   headers={**self.cab, "Prefer": "return=minimal"}, timeout=120),
                     f"apagar de {tabela}")

    def arquivos(self, prefixo):
        """Nomes já presentes no bucket sob `prefixo` (uma pasta por anexo)."""
        nomes, ini = set(), 0
        while True:
            r = self._ok(self.s.post(f"{self.url}/storage/v1/object/list/{BUCKET}",
                                     headers={**self.cab, "Content-Type": "application/json"},
                                     data=json.dumps({"prefix": prefixo, "limit": 1000, "offset": ini}),
                                     timeout=120), "listar o bucket")
            lote = r.json()
            nomes |= {x["name"] for x in lote}
            if len(lote) < 1000:
                return nomes
            ini += 1000

    def enviar(self, caminho, corpo, mime, sobrescrever=False):
        r = self.s.post(f"{self.url}/storage/v1/object/{BUCKET}/{quote(caminho)}",
                        headers={**self.cab, "Content-Type": mime or "application/octet-stream",
                                 "x-upsert": "true" if sobrescrever else "false"},
                        data=corpo, timeout=600)
        if r.status_code == 409 or (r.status_code == 400 and "already exists" in r.text):
            return False
        self._ok(r, f"enviar {caminho}")
        return True


# --------------------------------------------------------------------------
# texto: links de anexo do Trello -> anexo do hub
# --------------------------------------------------------------------------
RX_ANEXO = re.compile(r"https://(?:api\.)?trello\.com/1/cards/([0-9a-f]{24})/attachments/([0-9a-f]{24})/download/")


def achar_links(texto: str):
    """(início, fim, id do card, id do anexo) de cada link de anexo do Trello no texto.

    O nome do arquivo pode ter parênteses ("Mat._86927(imovel).pdf") e o link costuma
    estar dentro de um markdown "[x](link)": o fim é o primeiro espaço, aspas, sinal de
    maior/menor ou colchete, ou o ")" que fecha o markdown — o de dentro do nome, que
    tem o "(" correspondente, não conta."""
    for m in RX_ANEXO.finditer(texto or ""):
        i, prof = m.end(), 0
        while i < len(texto):
            c = texto[i]
            if c.isspace() or c in '<>"]':
                break
            if c == "(":
                prof += 1
            elif c == ")":
                if prof == 0:
                    break
                prof -= 1
            i += 1
        yield m.start(), i, m.group(1), m.group(2)


def reescrever(texto: str, caminhos: dict) -> str:
    """Troca link de anexo do Trello por `anexo:<caminho no bucket>`. Link para anexo
    que não veio (apagado no Trello) fica como está: já não abria lá."""
    if not texto:
        return texto
    partes, ultimo = [], 0
    for ini, fim, _card, att in achar_links(texto):
        if att in caminhos:
            partes += [texto[ultimo:ini], "anexo:" + caminhos[att]]
            ultimo = fim
    partes.append(texto[ultimo:])
    return "".join(partes)


# --------------------------------------------------------------------------
# montagem
# --------------------------------------------------------------------------
def casar_membros(exp, usuarios, mapa_manual):
    """Pessoa do Trello -> e-mail do hub. Devolve {trello_id: {nome, usuario, email}}."""
    pessoas = {}
    for m in exp["members"]:
        pessoas[m["id"]] = {"nome": m["fullName"], "usuario": m.get("username")}
    for a in exp["actions"]:
        mc = a.get("memberCreator") or {}
        if a.get("idMemberCreator") and a["idMemberCreator"] not in pessoas and mc.get("fullName"):
            pessoas[a["idMemberCreator"]] = {"nome": mc["fullName"], "usuario": mc.get("username")}
        mb = a.get("member") or {}
        if mb.get("id") and mb["id"] not in pessoas and mb.get("fullName"):
            pessoas[mb["id"]] = {"nome": mb["fullName"], "usuario": mb.get("username")}
    for c in exp["cards"]:
        for m in c.get("members") or []:
            pessoas.setdefault(m["id"], {"nome": m["fullName"], "usuario": m.get("username")})

    por_nome = defaultdict(list)
    por_primeiro = defaultdict(list)
    for u in usuarios:
        n = normal(u.get("nome") or u["email"].split("@")[0])
        por_nome[n].append(u["email"])
        if n:
            por_primeiro[n.split()[0]].append(u["email"])

    usados = Counter()
    for tid, p in pessoas.items():
        email = mapa_manual.get(p["usuario"] or "")
        if not email:
            n = normal(p["nome"])
            cands = por_nome.get(n) or (por_primeiro.get(n.split()[0]) if n else None) or []
            email = cands[0] if len(cands) == 1 else None
        p["email"] = email.lower() if email else None
        if p["email"]:
            usados[p["email"]] += 1
    repetidos = [e for e, n in usados.items() if n > 1]
    if repetidos:
        sys.exit("Duas pessoas do Trello casaram com o mesmo login do hub: "
                 + ", ".join(e.split("@")[0] for e in repetidos) + ". Use --mapa.")
    return pessoas


def montar(exp, pessoas, caminhos):
    nome_de = {tid: p["nome"] for tid, p in pessoas.items()}
    email_de = {tid: p["email"] for tid, p in pessoas.items()}
    listas = {l["id"]: l for l in exp["lists"]}
    cards = {c["id"]: c for c in exp["cards"]}
    etq_nome = {l["id"]: l["name"] for l in exp["labels"]}

    # quem criou cada card e quando, e quando foi arquivado
    criacao, arquivamento = {}, {}
    for a in sorted(exp["actions"], key=lambda a: a["date"]):
        cid = ((a.get("data") or {}).get("card") or {}).get("id")
        if not cid:
            continue
        if a["type"] in ("createCard", "copyCard", "convertToCardFromCheckItem", "moveCardToBoard"):
            criacao.setdefault(cid, a)
        if a["type"] == "updateCard" and (a["data"].get("old") or {}).get("closed") is False:
            arquivamento[cid] = a["date"]          # o último "arquivou" vale

    t = defaultdict(list)
    for l in exp["lists"]:
        t["kanban_listas"].append({
            "id": uid("lista", l["id"]), "trello_id": l["id"], "nome": l["name"],
            "pos": float(l["pos"]), "arquivada": bool(l["closed"]), "criado_em": data_do_id(l["id"])})
    for l in exp["labels"]:
        t["kanban_etiquetas"].append({
            "id": uid("etiqueta", l["id"]), "trello_id": l["id"], "nome": l["name"] or "",
            "cor": l.get("color"), "criado_em": data_do_id(l["id"])})

    for c in exp["cards"]:
        cria = criacao.get(c["id"])
        autor = (cria or {}).get("idMemberCreator") or c.get("idMemberCreator")
        arq = None
        if c["closed"]:
            arq = c.get("dateClosed") or arquivamento.get(c["id"]) or c.get("dateLastActivity")
        t["kanban_cards"].append({
            "id": uid("card", c["id"]), "trello_id": c["id"],
            "lista_id": uid("lista", c["idList"]),
            "nome": c["name"], "descricao": reescrever(c.get("desc") or "", caminhos),
            "pos": float(c["pos"]), "arquivado": bool(c["closed"]), "arquivado_em": arq,
            "prazo": c.get("due"), "prazo_concluido": bool(c.get("dueComplete")),
            "modelo": bool(c.get("isTemplate")),
            "criado_por": nome_de.get(autor), "criado_por_email": email_de.get(autor),
            "criado_em": (cria or {}).get("date") or data_do_id(c["id"]),
            "atualizado_em": c.get("dateLastActivity") or data_do_id(c["id"]),
            "trello_url": c.get("shortUrl")})
        for e in c.get("idLabels") or []:
            t["kanban_card_etiquetas"].append({"card_id": uid("card", c["id"]),
                                               "etiqueta_id": uid("etiqueta", e)})
        for m in c.get("idMembers") or []:
            t["kanban_card_membros"].append({"card_id": uid("card", c["id"]),
                                             "membro_id": uid("membro", m)})
        for a in c.get("attachments") or []:
            caminho = caminhos.get(a["id"]) if a.get("isUpload") else None
            if a.get("isUpload") and not caminho:
                continue                          # arquivo que o Trello não entregou: relatado à parte
            t["kanban_anexos"].append({
                "id": uid("anexo", a["id"]), "trello_id": a["id"], "card_id": uid("card", c["id"]),
                "nome": a.get("name") or a.get("fileName") or "anexo",
                "caminho": caminho, "url": None if a.get("isUpload") else a["url"],
                "mime": a.get("mimeType") or None, "bytes": a.get("bytes"),
                "autor_nome": nome_de.get(a.get("idMember")), "autor_email": email_de.get(a.get("idMember")),
                "criado_em": a.get("date") or data_do_id(a["id"]), "pos": float(a.get("pos") or 0)})

    for cl in exp["checklists"]:
        if cl["idCard"] not in cards:
            continue
        t["kanban_checklists"].append({
            "id": uid("checklist", cl["id"]), "trello_id": cl["id"], "card_id": uid("card", cl["idCard"]),
            "nome": cl["name"], "pos": float(cl["pos"])})
        for it in cl["checkItems"]:
            t["kanban_checkitens"].append({
                "id": uid("item", it["id"]), "trello_id": it["id"], "checklist_id": uid("checklist", cl["id"]),
                "nome": it["name"], "pos": float(it["pos"]), "concluido": it["state"] == "complete",
                "membro_id": uid("membro", it["idMember"]) if it.get("idMember") in pessoas else None,
                "prazo": it.get("due")})

    for a in exp["actions"]:
        d = a.get("data") or {}
        cid = (d.get("card") or {}).get("id")
        if a["type"] in ("commentCard", "copyCommentCard"):
            if cid not in cards:
                continue
            # comentário copiado (cópia de card/board) é do autor ORIGINAL, não de quem copiou
            autor = d.get("idOriginalCommenter") if d.get("idOriginalCommenter") in pessoas else a["idMemberCreator"]
            t["kanban_comentarios"].append({
                "id": uid("comentario", a["id"]), "trello_id": a["id"], "card_id": uid("card", cid),
                "autor_nome": nome_de.get(autor), "autor_email": email_de.get(autor),
                "texto": reescrever(d.get("text") or "", caminhos) or "(vazio)",
                "criado_em": a["date"], "editado_em": d.get("dateLastEdited")})
            continue
        # uma ação pode virar mais de um evento (duas etiquetas de uma vez): o primeiro
        # leva o id da ação, os seguintes o id + ":n" — eventos() é determinístico, então
        # a chave é a mesma em toda rodada
        for i, (tipo, dados) in enumerate(eventos(a, etq_nome)):
            tid = a["id"] if i == 0 else f"{a['id']}:{i}"
            t["kanban_atividade"].append({
                "id": uid("atividade", tid), "trello_id": tid,
                "card_id": uid("card", cid) if cid in cards else None,
                "tipo": tipo, "dados": dados,
                "autor_nome": nome_de.get(a["idMemberCreator"]) or (a.get("memberCreator") or {}).get("fullName"),
                "autor_email": email_de.get(a["idMemberCreator"]),
                "criado_em": a["date"]})
    return t


def eventos(a, etq_nome):
    """Ação do Trello -> lista de (tipo, dados) no vocabulário do hub (o mesmo dos gatilhos
    do hub_schema.sql e de KB_DADOS.frase). Uma ação pode virar mais de um evento: mudar
    duas etiquetas de uma vez, por exemplo."""
    d = a.get("data") or {}
    tp = a["type"]
    card = (d.get("card") or {}).get("name")
    base = {"card": card} if card else {}
    lista = (d.get("list") or {}).get("name")
    if tp == "createCard":
        return [("criou", {**base, "lista": lista})]
    if tp == "copyCard":
        return [("copiou", {**base, "origem": (d.get("cardSource") or {}).get("name"), "lista": lista})]
    if tp == "convertToCardFromCheckItem":
        return [("criou", {**base, "lista": lista, "de_item": (d.get("checklist") or {}).get("name")})]
    if tp == "moveCardToBoard":
        return [("veio_de_outro_board", {**base, "lista": lista})]
    if tp == "deleteCard":
        return [("excluiu", {"card": card or f"#{(d.get('card') or {}).get('idShort', '?')}", "lista": lista})]
    if tp == "updateCard":
        old = d.get("old") or {}
        out = []
        if "idList" in old:
            out.append(("moveu", {**base, "de": (d.get("listBefore") or {}).get("name"),
                                  "para": (d.get("listAfter") or {}).get("name")}))
        if "closed" in old:
            out.append(("arquivou" if not old["closed"] else "restaurou", base))
        if "name" in old:
            out.append(("renomeou", {**base, "de": old["name"], "para": card}))
        if "desc" in old:
            out.append(("descricao", base))
        if "due" in old:
            out.append(("prazo", {**base, "de": old["due"], "para": (d.get("card") or {}).get("due")}))
        if "dueComplete" in old:
            out.append(("prazo_concluido", {**base, "valor": not old["dueComplete"]}))
        if "idLabels" in old:
            antes = set(old.get("idLabels") or [])
            depois = set((d.get("card") or {}).get("idLabels") or [])
            out += [("etiqueta_pos", {**base, "etiqueta": etq_nome.get(e, "")}) for e in sorted(depois - antes)]
            out += [("etiqueta_tirou", {**base, "etiqueta": etq_nome.get(e, "")}) for e in sorted(antes - depois)]
        resto = set(old) - IGNORAR_UPDATE - {"idList", "closed", "name", "desc", "due", "dueComplete", "idLabels"}
        out += [("trello_" + k, base) for k in sorted(resto)]
        return out
    if tp == "updateCheckItemStateOnCard":
        st = (d.get("checkItem") or {}).get("state")
        return [("item_concluido" if st == "complete" else "item_reaberto",
                 {**base, "item": (d.get("checkItem") or {}).get("name")})]
    if tp in ("addMemberToCard", "removeMemberFromCard"):
        quem = (a.get("member") or {}).get("fullName") or (d.get("member") or {}).get("name")
        return [("membro_entrou" if tp == "addMemberToCard" else "membro_saiu", {**base, "membro": quem})]
    if tp in ("addAttachmentToCard", "deleteAttachmentFromCard"):
        return [("anexo_incluiu" if tp == "addAttachmentToCard" else "anexo_excluiu",
                 {**base, "anexo": (d.get("attachment") or {}).get("name")})]
    if tp in ("addChecklistToCard", "removeChecklistFromCard"):
        return [("checklist_criou" if tp == "addChecklistToCard" else "checklist_excluiu",
                 {**base, "checklist": (d.get("checklist") or {}).get("name")})]
    if tp == "updateChecklist":
        return [("checklist_renomeou", {**base, "de": (d.get("old") or {}).get("name"),
                                        "para": (d.get("checklist") or {}).get("name")})]
    if tp == "createList":
        return [("lista_criou", {"lista": lista})]
    if tp == "updateList":
        old = d.get("old") or {}
        out = []
        if "closed" in old:
            out.append(("lista_arquivou" if not old["closed"] else "lista_restaurou", {"lista": lista}))
        if "name" in old:
            out.append(("lista_renomeou", {"de": old["name"], "para": lista}))
        return out
    if tp == "addMemberToBoard":
        return [("board_membro", {"membro": (a.get("member") or {}).get("fullName")})]
    if tp in ("copyBoard", "addToOrganizationBoard", "createBoard"):
        return [("board_criou", {})]
    return [("trello_" + tp, base)]


# --------------------------------------------------------------------------
# anexos
# --------------------------------------------------------------------------
def baixar_anexos(tr, exp, cache: Path):
    """Baixa para o cache (uma vez só) e devolve {id do anexo: (arquivo local, nome, mime)}.

    Além dos anexos dos cards, os links de anexo citados em comentário e descrição que
    não estão em card nenhum do board (anexo apagado depois, ou de card copiado de outro
    board): se o Trello ainda entrega o arquivo, ele vem junto, para o link continuar
    abrindo no hub."""
    cache.mkdir(parents=True, exist_ok=True)
    alvos = {}
    for c in exp["cards"]:
        for a in c.get("attachments") or []:
            if a.get("isUpload"):
                alvos[a["id"]] = (a["url"], a.get("fileName") or a.get("name"), a.get("mimeType"), a.get("bytes"))
    textos = [c.get("desc") or "" for c in exp["cards"]]
    textos += [(x.get("data") or {}).get("text") or "" for x in exp["actions"]
               if x["type"] in ("commentCard", "copyCommentCard")]
    orfaos = {}
    for txt in textos:
        for ini, fim, _c, att in achar_links(txt):
            if att not in alvos:
                url = txt[ini:fim]
                # no link o nome vem codificado (%20, %C3%A7...); no anexo de card, não
                orfaos[att] = (url, unquote(url.rsplit("/", 1)[-1]), None, None)

    obtidos, falhas = {}, []
    todos = list(alvos.items()) + list(orfaos.items())
    for i, (att, (url, nome, mime, tam)) in enumerate(todos, 1):
        local = cache / att
        if not local.exists():
            r = tr.baixar(url)
            if r.status_code != 200:
                falhas.append((att, nome, r.status_code, att in orfaos))
                continue
            tmp = local.with_suffix(".parcial")
            tmp.write_bytes(r.content)
            tmp.replace(local)
        if tam and local.stat().st_size != tam:
            falhas.append((att, nome, f"tamanho {local.stat().st_size} != {tam}", att in orfaos))
            local.unlink()
            continue
        nome = nome or "arquivo"
        obtidos[att] = (local, nome, mime or mimetypes.guess_type(nome)[0] or "application/octet-stream")
        if i % 100 == 0:
            print(f"  anexos: {i}/{len(todos)}")
    return obtidos, falhas, set(alvos), set(orfaos)


def caminho_no_bucket(att, nome):
    return f"trello/{att}/{nome_seguro(nome)}"


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gravar", action="store_true")
    ap.add_argument("--dump")
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "hub_kanban"))
    ap.add_argument("--mapa")
    ap.add_argument("--forcar", action="store_true")
    args = ap.parse_args()
    # nome de pessoa e de arquivo com acento: no PowerShell redirecionado para arquivo a
    # saída seria cp1252 e um caractere fora dele derrubaria a rodada no meio
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    cfg = credenciais()
    tr = Trello(cfg["TRELLO_API_KEY"], cfg["TRELLO_TOKEN"])
    sb = Supabase(cfg["SUPABASE_URL"], cfg["SUPABASE_SERVICE_ROLE_KEY"])
    cache = Path(args.cache)

    # 1) export
    if args.dump and Path(args.dump).exists():
        exp = json.loads(Path(args.dump).read_text(encoding="utf-8"))
        print(f"export lido de {args.dump} ({exp.get('exportado_em', 'sem data')})")
    else:
        print("baixando o board do Trello…")
        exp = tr.exportar()
        destino = Path(args.dump) if args.dump else cache / "export.json"
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_text(json.dumps(exp, ensure_ascii=False), encoding="utf-8")
        print(f"export salvo em {destino}")
    if exp["board"]["id"] != BOARD_ID:
        sys.exit("O export não é do board do Kanban.")

    # 2) membros
    usuarios = sb.select("allowed_users", "email,nome,role,ativo")
    acesso = {r["email"] for r in sb.select("user_dashboard_access", "email,dashboard", "dashboard=eq.kanban")}
    mapa = json.loads(Path(args.mapa).read_text(encoding="utf-8")) if args.mapa else {}
    pessoas = casar_membros(exp, usuarios, mapa)
    print("\nPessoas do Trello -> login do hub:")
    for tid, p in sorted(pessoas.items(), key=lambda kv: kv[1]["nome"].lower()):
        print(f"  {p['nome']:<40} @{p['usuario'] or '?':<22} "
              + (f"-> {p['email'].split('@')[0]}" if p["email"] else "-> (sem login no hub)"))
    sem_aba = sorted(u["email"].split("@")[0] for u in usuarios
                     if u["ativo"] and u["role"] != "admin" and u["email"] not in acesso)
    if sem_aba:
        print("  ainda SEM a aba kanban no hub: " + ", ".join(sem_aba))

    # 3) anexos
    print("\nanexos: baixando do Trello para o cache (só o que falta)…")
    obtidos, falhas, dos_cards, orfaos = baixar_anexos(tr, exp, cache)
    caminhos = {att: caminho_no_bucket(att, nome) for att, (_l, nome, _m) in obtidos.items()}
    falhas_cards = [f for f in falhas if not f[3]]
    print(f"  {sum(1 for a in obtidos if a in dos_cards)}/{len(dos_cards)} anexos de card; "
          f"{sum(1 for a in obtidos if a in orfaos)}/{len(orfaos)} citados em comentário sem card")
    for att, nome, st, orfao in falhas:
        print(f"  {'(citado) ' if orfao else ''}não veio: {nome} [{st}]")

    # 4) montagem + conferência
    t = montar(exp, pessoas, caminhos)
    n_cards = len(exp["cards"])
    n_arq = sum(c["closed"] for c in exp["cards"])
    n_itens = sum(len(cl["checkItems"]) for cl in exp["checklists"])
    n_coment = sum(1 for a in exp["actions"] if a["type"] in ("commentCard", "copyCommentCard"))
    links_restantes = sum(1 for linha in t["kanban_comentarios"] for _ in achar_links(linha["texto"])) \
        + sum(1 for linha in t["kanban_cards"] for _ in achar_links(linha["descricao"]))
    print(f"\nTrello: {len(exp['lists'])} listas ({sum(l['closed'] for l in exp['lists'])} arquivadas), "
          f"{n_cards} cards ({n_arq} arquivados), {len(exp['checklists'])} checklists / {n_itens} itens, "
          f"{n_coment} comentários, {sum(len(c.get('attachments') or []) for c in exp['cards'])} anexos, "
          f"{len(exp['actions'])} ações")
    print("Hub:    " + ", ".join(f"{k.replace('kanban_', '')}={len(v)}" for k, v in t.items()))
    print(f"links de anexo do Trello que continuam no texto (anexo não veio): {links_restantes}")
    assert len(t["kanban_cards"]) == n_cards and len(t["kanban_checkitens"]) == n_itens \
        and len(t["kanban_comentarios"]) == n_coment, "contagem não bate com o export"
    ids_atv = Counter(x["trello_id"] for x in t["kanban_atividade"])
    assert not [k for k, v in ids_atv.items() if v > 1], "evento de histórico repetido"

    if not args.gravar:
        print("\nPRÉVIA — nada gravado. Rode com --gravar para gravar.")
        return

    # 5) trava de virada
    if not args.forcar:
        do_hub = {tab: sb.select(tab, "id", "trello_id=is.null&limit=1")
                  for tab in ("kanban_cards", "kanban_comentarios", "kanban_anexos", "kanban_checklists")}
        usados = [tab for tab, linhas in do_hub.items() if linhas]
        if usados:
            sys.exit("O board já está sendo usado no hub (" + ", ".join(usados) + " com linha criada "
                     "lá). Reimportar espelharia o Trello e desfaria o que foi feito no hub. "
                     "Só com --forcar.")

    # 6) arquivos no bucket
    print("\nenviando anexos ao bucket (só os que faltam)…")
    ja = sb.arquivos("trello/")
    enviados = 0
    for att, (local, nome, mime) in obtidos.items():
        if att in ja:
            continue
        sb.enviar(caminhos[att], local.read_bytes(), mime)
        enviados += 1
        if enviados % 100 == 0:
            print(f"  {enviados} enviados")
    print(f"  {enviados} enviados agora; {len(obtidos) - enviados} já estavam lá")
    hoje = dt.date.today().isoformat()
    sb.enviar(f"_trello/export-{hoje}.json", json.dumps(exp, ensure_ascii=False).encode("utf-8"),
              "application/json", sobrescrever=True)
    print(f"  export bruto: {BUCKET}/_trello/export-{hoje}.json")

    # 7) membros. O id de quem veio do Trello é fixo (os cards apontam para ele). Se a
    #    pessoa abriu o board no hub antes desta rodada, kanban_entrar() já lhe deu uma
    #    linha com outro id e o mesmo e-mail: ela é absorvida pela do Trello (vínculos
    #    passam para o id fixo, a linha avulsa sai), senão o e-mail repetido barraria.
    existentes = sb.select("kanban_membros", "id,trello_id,email")
    por_email = {m["email"]: m for m in existentes if m["email"]}
    for tid, p in pessoas.items():
        fixo = uid("membro", tid)
        avulsa = por_email.get(p["email"]) if p["email"] else None
        if avulsa and avulsa["id"] != fixo:
            sb.patch("kanban_membros", f"id=eq.{avulsa['id']}", {"email": None})
        sb.upsert("kanban_membros", [{"id": fixo, "trello_id": tid, "nome": p["nome"],
                                      "usuario": p["usuario"], "email": p["email"]}])
        if avulsa and avulsa["id"] != fixo:
            for tab in ("kanban_card_membros", "kanban_checkitens"):
                sb.patch(tab, f"membro_id=eq.{avulsa['id']}", {"membro_id": fixo})
            sb.apagar("kanban_membros", "id", [avulsa["id"]])
    # quem tem a aba e não estava no Trello entra também, para poder ser incluído em card
    ja_membros = {p["email"] for p in pessoas.values() if p["email"]} | set(por_email)
    novos = [{"nome": (u.get("nome") or u["email"].split("@")[0]).strip(), "email": u["email"]}
             for u in usuarios
             if u["ativo"] and (u["role"] == "admin" or u["email"] in acesso) and u["email"] not in ja_membros]
    if novos:
        sb.inserir("kanban_membros", novos)

    # 8) tabelas, na ordem das chaves estrangeiras
    for tab in ("kanban_listas", "kanban_etiquetas", "kanban_cards", "kanban_checklists",
                "kanban_checkitens", "kanban_comentarios", "kanban_anexos", "kanban_atividade"):
        sb.upsert(tab, t[tab])
        print(f"  {tab}: {len(t[tab])}")
    cards_trello = [c["id"] for c in t["kanban_cards"]]
    for tab in ("kanban_card_etiquetas", "kanban_card_membros"):
        sb.apagar(tab, "card_id", cards_trello)
        sb.inserir(tab, t[tab])
        print(f"  {tab}: {len(t[tab])}")

    # 9) o que saiu do Trello entre uma rodada e outra sai do hub (só linha importada)
    for tab in ("kanban_atividade", "kanban_anexos", "kanban_comentarios", "kanban_checkitens",
                "kanban_checklists", "kanban_cards", "kanban_etiquetas", "kanban_listas"):
        agora = {x["trello_id"] for x in t[tab]}
        sobra = [x["id"] for x in sb.select(tab, "id,trello_id", "trello_id=not.is.null")
                 if x["trello_id"] not in agora]
        if sobra:
            sb.apagar(tab, "id", sobra)
            print(f"  {tab}: {len(sobra)} que não existem mais no Trello, removidas")

    # 10) conferência no banco
    print("\nconferência (banco × Trello):")
    ok = True
    for tab, esperado in (("kanban_listas", len(exp["lists"])), ("kanban_cards", n_cards),
                          ("kanban_checklists", len(exp["checklists"])), ("kanban_checkitens", n_itens),
                          ("kanban_comentarios", n_coment), ("kanban_anexos", len(t["kanban_anexos"])),
                          ("kanban_atividade", len(t["kanban_atividade"]))):
        n = len(sb.select(tab, "id", "trello_id=not.is.null"))
        ok &= n == esperado
        print(f"  {tab:<22} {n:>6}  {'ok' if n == esperado else f'ESPERADO {esperado}'}")
    n_arq_db = len(sb.select("kanban_cards", "id", "arquivado=is.true&trello_id=not.is.null"))
    ok &= n_arq_db == n_arq
    print(f"  {'cards arquivados':<22} {n_arq_db:>6}  {'ok' if n_arq_db == n_arq else f'ESPERADO {n_arq}'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
