"""Gera um link de acesso ao hub SEM depender de e-mail.

Serve pra duas coisas:
  - destravar quando o SMTP está fora do ar ou estourou o rate limit;
  - entrar como admin numa máquina nova sem esperar caixa de entrada.

Usa a Admin API com a service_role, então roda só na sua máquina, com o .env
da raiz (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).

O link é de USO ÚNICO e expira (padrão: 1h). Tratar como senha: não colar em
chat, não mandar por WhatsApp de grupo, não commitar.

Uso:
    python tools/login_link.py voce@luxor.com.br
    python tools/login_link.py voce@luxor.com.br --site http://localhost:5178
"""
import argparse
import sys
from pathlib import Path

import requests
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://lxplanejamentoecontrole.netlify.app"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("email")
    ap.add_argument("--site", default=SITE, help=f"origem de destino (padrão: {SITE})")
    args = ap.parse_args()

    cfg = dotenv_values(ROOT / ".env")
    url = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env da raiz.")

    email = args.email.strip().lower()
    site = args.site.rstrip("/")

    r = requests.post(
        f"{url}/auth/v1/admin/generate_link",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
        # redirect_to vai no TOPO do corpo. A REST API não lê o `options.redirectTo`
        # do SDK JS — aninhar ali faz o GoTrue ignorar e cair no Site URL.
        json={"type": "magiclink", "email": email, "redirect_to": site + "/"},
        timeout=30,
    )
    if r.status_code >= 300:
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        msg = body.get("msg") or body.get("message") or r.text[:200]
        if "not found" in msg.lower() or r.status_code == 404:
            sys.exit(f"'{email}' não tem conta em auth.users.\n"
                     f"Crie em Authentication > Users > Add user (sem enviar convite).")
        sys.exit(f"HTTP {r.status_code}: {msg}")

    link = r.json().get("action_link")
    if not link:
        sys.exit(f"Resposta sem action_link: {r.text[:300]}")

    print(f"\nLink de acesso para {email} (uso único, expira em ~1h):\n")
    print(link)
    print("\nAbra num navegador. Não repasse — quem tem o link entra como essa pessoa.\n")


if __name__ == "__main__":
    main()
