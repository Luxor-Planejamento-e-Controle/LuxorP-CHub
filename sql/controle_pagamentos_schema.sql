-- =====================================================================
-- Controle de Pagamentos — acesso ao painel, já sob o controle do hub.
--
-- Não cria tabela nova: usa `app_state`, a mesma do Projetos e do Saldo
-- Bancário (id + jsonb), com um documento de id 'controle_pagamentos'. A
-- autorização passa por `public.hub_can('controle_pagamentos')`, o mesmo
-- porteiro do resto do hub.
--
-- Substitui a proposta anterior (`cp_fornecedores`, tabela dedicada), que
-- criava estrutura nova para guardar 120 registros que mudam 46 vezes por ano.
--
-- DDL apenas. Nenhum dado real (este repo é público). Rodar no SQL editor.
--
-- PRÉ-CONDIÇÃO: `hub_schema.sql` e `projetos_schema.sql` já rodados — é o
-- segundo que cria `app_state`. Idempotente: pode rodar de novo.
--
-- O id 'controle_pagamentos' já está na lista de painéis do `hub_schema.sql`,
-- que é onde ela mora. Este arquivo NÃO redefine aquela constraint: a lista
-- existiria em dois lugares e reexecutar o hub_schema — que é feito para ser
-- reexecutado — apagaria este painel dela em silêncio.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Policies do documento do painel em app_state.
--
--    O painel LÊ e ESCREVE: o cadastro de fornecedores fixos é mantido na
--    própria tela. Escrita liberada para quem tem o painel (não só admin)
--    porque manter o cadastro É o uso normal dela.
--
--    O resultado do batimento NÃO se escreve aqui — ele vem do bucket,
--    publicado pelo ETL. Ver a seção 3.
-- ---------------------------------------------------------------------
drop policy if exists hub_controle_pagamentos_select on app_state;
create policy hub_controle_pagamentos_select on app_state
  for select to authenticated
  using ( id = 'controle_pagamentos' and public.hub_can('controle_pagamentos') );

drop policy if exists hub_controle_pagamentos_update on app_state;
create policy hub_controle_pagamentos_update on app_state
  for update to authenticated
  using      ( id = 'controle_pagamentos' and public.hub_can('controle_pagamentos') )
  with check ( id = 'controle_pagamentos' and public.hub_can('controle_pagamentos') );

-- ---------------------------------------------------------------------
-- 2) Documento único do painel, vazio. O cadastro real é carregado pelo
--    seed (gerado da planilha) e mantido pela tela — NÃO existe seed
--    versionado com dado real, porque este repo é público e nome de
--    fornecedor com valor contratado é informação interna.
--
--    Forma esperada do jsonb:
--      { "fornecedores": [
--          { ano, cod, empresa, contagem, fornecedor,
--            valor_usual_txt, valor_usual, venc_orig, obs, reajuste,
--            meses: ["jan",...], ativo, obs_interna,
--            atualizado_em, atualizado_por } ] }
--
--    (ano, cod, empresa, contagem) é a chave do batimento: o mesmo fornecedor
--    pode ter mais de um título fixo no mês, e a N-ésima linha do cadastro
--    casa com o N-ésimo título. Chave repetida faz o batimento não saber qual
--    é qual — a tela avisa antes de gravar.
-- ---------------------------------------------------------------------
insert into app_state (id, data) values ('controle_pagamentos', '{}'::jsonb)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3) O resultado do batimento NÃO entra aqui: é publicado no bucket
--    `hub-data` como `controle_pagamentos.json` pelo ETL, e a policy
--    `hub_data_read` (hub_schema.sql) já libera por
--    hub_can(split_part(name,'.',1)) — o mesmo id deste arquivo.
--    Nada a fazer, desde que o nome do arquivo continue sendo o id do painel.
--
--    O ETL LÊ este documento (com service_role, ignorando RLS) para saber o
--    cadastro, bate contra os títulos do Bimer em Python e publica o
--    resultado. Por isso uma edição no cadastro só muda os números do painel
--    na execução seguinte — e a tela diz isso, em vez de deixar parecer que
--    a edição não funcionou.
-- ---------------------------------------------------------------------
