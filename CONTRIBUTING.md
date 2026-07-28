# Contribuindo com o Hub P&C

Como adicionar ou alterar um dashboard. Leia antes do primeiro commit —
o repositório é **público** e o hub serve dado financeiro e PII.

## Regra que não se negocia

**Nenhum dado real entra no Git.** Nem planilha, nem JSON de saída de ETL, nem
e-mail de usuário, nem chave. O repositório guarda só a casca do site.

Dado real vai para o **bucket privado `hub-data`** no Supabase, publicado por
`tools/publish_hub.py`, e chega no navegador só depois do login. Já está tudo
no `.gitignore`, e há duas barreiras automáticas:

| Barreira | Onde roda | Dá pra pular? |
| --- | --- | --- |
| `.githooks/pre-commit` | sua máquina | sim (`--no-verify`), e só existe se você instalar |
| `.github/workflows/guarda.yml` | em todo PR | não |

As duas usam o mesmo script, `tools/scan_segredos.sh`. Instale o hook uma vez
por clone para descobrir o problema antes do push:

```bash
python tools/install_hooks.py
```

## Fluxo

`main` é protegida: exige Pull Request com 1 aprovação. Ninguém publica direto.

1. Branch a partir da `main`: `git switch -c dash/nome-do-painel`
2. Desenvolva. Para ver com dado real na sua máquina, gere os arquivos locais
   (`python tools/build_data.py`) — eles ficam em `assets/data/`, que é ignorado.
3. Push da branch e abra o PR.
4. O Netlify cria um **deploy preview** com URL própria. Revise ali, no
   dashboard rodando — não só no diff.
5. Aprovado, o merge publica.

**Agrupe commits antes do push.** O plano do Netlify cobra **15 créditos por
deploy de produção** e dá 300 por mês, ou seja **20 deploys**. Deploy preview
não consome. O `netlify.toml` já cancela o build quando o commit mexe só em
`tools/`, `docs/`, `sql/` ou `.md`.

## Checklist de um dashboard novo

Um painel só aparece se **as três coisas** estiverem no lugar. Faltando
qualquer uma ele some da navegação em silêncio, por desenho — melhor sumir do
que abrir vazio.

**1. Permissão** — em [`sql/hub_schema.sql`](sql/hub_schema.sql), inclua o id no
`CHECK` de `user_dashboard_access.dashboard`. Sem isso a RLS recusa o insert e
o bucket nega o download.

```sql
dashboard text not null check (dashboard in (..., 'meu_painel'))
```

**2. Dado** — publique no bucket com o nome `<id>.json`. **O nome importa**: a
policy de leitura usa o prefixo antes do ponto para decidir quem pode baixar
(`hub_can('meu_painel')`). Registre o dataset em `tools/publish_hub.py`.

**3. Tela** — em [`assets/app.js`](assets/app.js):

- entrada em `ROUTES` com `id`, `title`, `icon` e a função de render
- caso em `temDado()` dizendo qual variável precisa estar carregada
- carregamento em `HUB_DATASETS` no [`assets/auth.js`](assets/auth.js)

## Coisas que já morderam

- **PII nunca vira arquivo estático.** A inadimplência vem do bucket e entra no
  iframe por `srcdoc`. Não use `blob:` — URL de blob tem caminho opaco e
  `/assets/vendor/...` não resolve lá dentro.
- **Não recalcule métrica que a fonte já traz.** %Dia, MTD, QTD, YTD e 36M vêm
  prontos do ETL. Refazer a conta no front já produziu número errado.
- **Cuidado com escape em string Python não-raw.** `\25B2` num CSS gerado vira
  caractere de controle (`\25` é octal). Use o caractere direto ou `r"""`.
- **Cor nova precisa passar em contraste e matiz.** Fundo escuro: mínimo 3:1, e
  pelo menos ~20° de distância de matiz dos vizinhos, senão as fatias do gráfico
  se confundem.

## Dúvida

Abra o PR mesmo incompleto e marque como rascunho. Preview é de graça e revisar
cedo custa menos que refazer.
