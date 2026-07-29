#!/bin/sh
# Recusa dado real, PII, e-mail @luxor.com.br e segredo. Repo é PÚBLICO.
#
# Fonte ÚNICA da regra: usado pelo hook .githooks/pre-commit (local, opcional)
# e pelo .github/workflows/guarda.yml (no PR, obrigatório). Se as duas cópias
# divergirem, a que vale é a Action — o hook depende de cada clone ter rodado
# tools/install_hooks.py, então não dá pra confiar nele como barreira.
#
# Uso:
#   tools/scan_segredos.sh --staged            arquivos vêm do índice (git show :f)
#   tools/scan_segredos.sh arquivo...          arquivos vêm do disco
#
# Sai 0 = limpo. Sai 1 = achou problema (mensagens no stderr).

modo_staged=0
if [ "$1" = "--staged" ]; then
  modo_staged=1
  shift
  set -- $(git diff --cached --name-only --diff-filter=ACM)
fi

[ $# -eq 0 ] && exit 0

fail=0
say() { echo "  ✗ $1" >&2; fail=1; }

# Lê o conteúdo do arquivo conforme o modo.
ler() {
  if [ "$modo_staged" = "1" ]; then git show ":$1" 2>/dev/null
  else [ -f "$1" ] && cat "$1" 2>/dev/null
  fi
}

# --- 1) caminhos que nunca podem entrar ---------------------------------
for f in "$@"; do
  case "$f" in
    assets/data/*|assets/inadimplencia/*|output_pbi/*)
      say "dado real/PII: $f" ;;
    .env|.env.*)
      [ "$f" = ".env.example" ] || say "arquivo de segredo: $f" ;;
    *.local.sql)
      say "seed com dado real: $f" ;;
    *.xlsx|*.xlsm|*.csv|*.parquet|*.pbix)
      say "planilha/base: $f" ;;
    # Fonte comercial (Fakt Pro/Slab, licença OurType) não pode ser
    # redistribuída num repo público. O site usa subset woff embutido em
    # assets/fonts.css — arquivo de fonte solto aqui é sempre engano.
    *.otf|*.ttf|*.woff|*.woff2|*.eot)
      say "fonte licenciada solta (usar o subset em assets/fonts.css): $f" ;;
    *__MACOSX/*|*/.DS_Store|.DS_Store|*/Thumbs.db|*/desktop.ini)
      say "lixo de sistema: $f" ;;
  esac
done

# --- 2) conteúdo -------------------------------------------------------
# Fora do scan: assets/vendor/ (bundles minificados batem em qualquer padrão),
# .githooks/ e este script (contêm os próprios padrões e se auto-acusariam).
scan=""
for f in "$@"; do
  case "$f" in
    assets/vendor/*|.githooks/*|tools/scan_segredos.sh) continue ;;
    # binário não tem texto pra vazar e ainda gera aviso de byte nulo
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.svg|*.pdf|*.zip|*.woff|*.woff2|*.ttf|*.otf) continue ;;
  esac
  scan="$scan $f"
done
[ -z "$scan" ] && { [ $fail -eq 0 ] && exit 0 || exit 1; }

pat_segredo='sb_secret_[A-Za-z0-9_-]\{8,\}\|AccountKey=[A-Za-z0-9+/=]\{20,\}\|DefaultEndpointsProtocol=https;AccountName=\|-----BEGIN [A-Z ]*PRIVATE KEY-----'
# E-mail @luxor.com.br real. Passam: placeholders de doc e o curinga SQL
# `like '%@luxor.com.br'` (o % é do LIKE, não faz parte do endereço).
pat_email='[A-Za-z0-9._%+-]\{1,\}@luxor\.com\.br'
placeholders="voce@\|fulano@\|exemplo@\|usuario@\|admin@exemplo\|seu-email@\|novo@\|saiu@\|alguem@\|nome@\|'%@\|\"%@\|<[a-z0-9]*>@"

for f in $scan; do
  blob=$(ler "$f") || continue
  [ -z "$blob" ] && continue

  # JWT do Supabase com role != anon. A anon key é pública por design; a
  # service_role ignora RLS e daria acesso total ao banco.
  for t in $(printf '%s' "$blob" | grep -o 'eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*'); do
    corpo=$(printf '%s' "$t" | cut -d. -f2)
    decodificado=$(printf '%s==' "$corpo" | base64 -d 2>/dev/null)
    case "$decodificado" in
      *'"role":"service_role"'*|*'"role": "service_role"'*)
        say "service_role JWT em $f" ;;
    esac
  done

  hit=$(printf '%s' "$blob" | grep -n "$pat_segredo" | head -1)
  [ -n "$hit" ] && say "segredo em $f: $(printf '%s' "$hit" | cut -c1-90)"

  hit=$(printf '%s' "$blob" | grep -n "$pat_email" | grep -v "$placeholders" | head -1)
  [ -n "$hit" ] && say "e-mail real em $f: $(printf '%s' "$hit" | cut -c1-90)"
done

exit $fail
