-- =====================================================================
-- Cadastro de naturezas do painel de Gastos do Haras — EXEMPLO.
--
-- Os valores abaixo são FICTÍCIOS. A lista real de naturezas, responsáveis e
-- códigos do Bimer é informação interna, e este repositório é público: o
-- cadastro real vem de `python cadastro_naturezas.py` (repositório Automacoes,
-- pasta "Controle de Gasto do HARAS"), que gera o JSON fora do Git, e o SQL
-- resultante fica em sql/haras_naturezas.local.sql (ignorado: *.local.sql).
--
-- Rodar UMA vez, depois de `hub_schema.sql`. Depois disso o documento é mantido
-- pela tela "Naturezas do Haras" — rodar de novo APAGA o que foi editado nela.
-- =====================================================================

-- naturezas  o que entra no Controle. `bimer` = códigos numéricos do Bimer que contam
--            para ela; `path` = grupos da raiz ao pai; `ordem` de 10 em 10.
-- ignoradas  o que o Bimer traz e está FORA do escopo por decisão. Código que não está
--            em nenhuma das duas listas é PENDENTE e aparece na tela para alguém decidir.
insert into app_state (id, data, updated_at)
values ('haras_naturezas', $json$
{"versao":1,
 "naturezas":[
   {"ordem":10,"cod":"10.1.01","alt":"","nome":"Natureza de exemplo","resp":"Fulano",
    "bimer":[1001],"path":["Custos e Despesas","Custos","Grupo de exemplo"]}
 ],
 "ignoradas":[
   {"bimer":9001,"nome":"NATUREZA FORA DO ESCOPO (EXEMPLO)"}
 ]}
$json$::jsonb, now())
on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at;

-- Quem vai editar precisa do painel (admin vê tudo e não precisa de linha):
--   insert into user_dashboard_access (email, dashboard) values ('fulano@exemplo.com', 'haras_naturezas');
