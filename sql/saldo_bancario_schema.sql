-- =====================================================================
-- Saldo Bancário — acesso ao painel, já sob o controle do hub.
--
-- Não cria tabela nova: usa `app_state`, a mesma do Projetos (id + jsonb),
-- com um documento de id 'saldo_bancario'. A autorização passa por
-- `public.hub_can('saldo_bancario')`, o mesmo porteiro do resto do hub.
--
-- DDL apenas. Nenhum dado real (este repo é público). Rodar no SQL editor.
--
-- PRÉ-CONDIÇÃO: `hub_schema.sql` e `projetos_schema.sql` já rodados — é o
-- segundo que cria `app_state`. Idempotente: pode rodar de novo.
--
-- O id 'saldo_bancario' já está na lista de painéis do `hub_schema.sql`, que é
-- onde ela mora. Este arquivo NÃO redefine aquela constraint: a lista existiria
-- em dois lugares e reexecutar o hub_schema — que é feito para ser reexecutado —
-- apagaria este painel dela em silêncio, e a liberação de acesso passaria a
-- falhar sem que nada aqui tivesse mudado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Policies do documento do painel em app_state.
--
--    O painel LÊ e ESCREVE: o saldo de cada conta e as entradas previstas
--    não vêm de sistema nenhum — alguém digita, aqui. Enquanto não houver
--    API bancária, esse input é a parte humana do processo.
--
--    Escrita liberada para quem tem o painel (não só admin) justamente
--    porque digitar o saldo É o uso normal da tela.
--
--    CADA POLICY É AMARRADA AO id DO SEU DOCUMENTO. Policy no Postgres vale para a
--    TABELA inteira, e policies permissivas se SOMAM (OR). Sem o `id = 'saldo_bancario'`,
--    quem tem acesso a qualquer painel que usa app_state leria e gravaria a linha de
--    todos os outros — o colchão das contas do Saldo Bancário para quem só tem
--    Projetos, por exemplo. Com um documento só isso não aparecia; app_state hoje
--    tem três. O `.eq('id', ...)` do front é escopo de cliente, não barreira: a anon
--    key é pública e a chamada pode ser feita direto na API.
-- ---------------------------------------------------------------------
drop policy if exists hub_saldo_bancario_select on app_state;
create policy hub_saldo_bancario_select on app_state
  for select to authenticated
  using ( id = 'saldo_bancario' and public.hub_can('saldo_bancario') );

drop policy if exists hub_saldo_bancario_update on app_state;
create policy hub_saldo_bancario_update on app_state
  for update to authenticated
  using      ( id = 'saldo_bancario' and public.hub_can('saldo_bancario') )
  with check ( id = 'saldo_bancario' and public.hub_can('saldo_bancario') );

-- ---------------------------------------------------------------------
-- 2) Documento único do painel, vazio. As entradas por semana são preenchidas
--    pela própria tela; o cadastro das contas com os colchões é seed, e o real
--    NÃO é versionado — este repo é público e colchão de conta bancária é
--    informação interna. O formato está em `seed_saldo_bancario.example.sql`,
--    com valores fictícios, mesmo padrão do `seed_allowlist.example.sql`.
--
--    Forma esperada do jsonb:
--      { "contas":   [ {chave, banco, tipo, colchao, ativa} ],
--        "entradas": { "AAAA-MM-DD": [ {chave, saldo, a_receber, por, em} ] } }
--    A chave de `entradas` é a QUARTA-FEIRA da semana: a projeção sempre foi
--    de quarta a quarta, e guardar por semana preserva o histórico.
-- ---------------------------------------------------------------------
insert into app_state (id, data) values ('saldo_bancario', '{}'::jsonb)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3) O snapshot dos títulos a pagar NÃO entra aqui: ele é publicado no
--    bucket `hub-data` como `saldo_bancario.json` pelo ETL semanal, e a
--    policy `hub_data_read` (hub_schema.sql) já libera por
--    hub_can(split_part(name,'.',1)) — ou seja, o mesmo id deste arquivo.
--    Nada a fazer, desde que o nome do arquivo continue sendo o id do painel.
-- ---------------------------------------------------------------------
