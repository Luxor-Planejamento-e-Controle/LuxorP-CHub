"""Aponta o Git deste clone para os hooks versionados em .githooks/.

O repo é público: o pre-commit recusa dado real, PII, e-mail @luxor.com.br e
segredo. Hook não vem com o clone — cada máquina roda isto uma vez.

Uso: python tools/install_hooks.py
"""
import os
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    hooks = ROOT / ".githooks"
    if not hooks.is_dir():
        sys.exit("Pasta .githooks/ não encontrada.")

    subprocess.run(["git", "config", "core.hooksPath", ".githooks"],
                   cwd=ROOT, check=True)

    # Git no Windows respeita o bit de execução do índice; garante nas duas pontas.
    # (update-index só vale pra arquivo já rastreado — antes do 1º commit, ignora.)
    for h in hooks.iterdir():
        if not h.is_file():
            continue
        h.chmod(h.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        rel = h.relative_to(ROOT).as_posix()
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", rel],
                                 cwd=ROOT, capture_output=True).returncode == 0
        if tracked:
            subprocess.run(["git", "update-index", "--chmod=+x", rel], cwd=ROOT, check=False)

    print("core.hooksPath = .githooks")
    print("hooks ativos:", ", ".join(sorted(h.name for h in hooks.iterdir() if h.is_file())))
    print("\nTeste rápido:  git commit --allow-empty -m teste")


if __name__ == "__main__":
    main()
