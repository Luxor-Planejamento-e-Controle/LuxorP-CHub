"""A cifra das Senhas P&C, do lado Python — par do assets/senhas/sh_cripto.js.

Chave: PBKDF2-SHA256 da senha mestra (sal e iterações de `senhas_cofre`) -> AES-256-GCM.
Texto: "v1:" + base64(iv de 12 bytes || cifra+tag). Arquivo: os mesmos bytes, sem prefixo.
Mexeu no formato aqui, mexe lá — o teste da aba (assets/senhas/test_painel.py) cifra com
este módulo e decifra no navegador, e vice-versa.

Módulo à parte (e não dentro do import) para o teste rodar no CI só com `cryptography`,
sem as dependências de rede do import.
"""
from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITERACOES = 600_000            # PBKDF2-SHA256 (recomendação OWASP de 2023)
VERIFICADOR = "senhas-pc"      # igual ao SH_CRIPTO.VERIFICADOR


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
