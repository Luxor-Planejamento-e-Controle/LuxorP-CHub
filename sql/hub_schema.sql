-- =====================================================================
-- Luxor P&C Hub — controle de acesso (allowlist + RBAC usuário×dashboard)
-- e bucket privado com os snapshots de dado publicados pelos ETLs.
--
-- DDL apenas. Nenhum e-mail real aqui (o seed vive só no Supabase).
-- Rodar no SQL editor do projeto Supabase do hub.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Allowlist: quem pode entrar no hub. Signup público deve ficar
--    DESLIGADO no painel (Authentication > Providers > Email > Signups).
-- ---------------------------------------------------------------------
create table if not exists allowed_users (
  email       text primary key,
  nome        text,
  role        text not null default 'user' check (role in ('admin','user')),
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- e-mail sempre em minúsculas (o JWT devolve minúsculo)
create or replace function public.lower_email() returns trigger
language plpgsql as $$
begin
  new.email := lower(new.email);
  return new;
end $$;

drop trigger if exists allowed_users_lower on allowed_users;
create trigger allowed_users_lower before insert or update on allowed_users
  for each row execute function public.lower_email();

-- ---------------------------------------------------------------------
-- 2) Permissão por dashboard. Admin não precisa de linha aqui (vê tudo).
-- ---------------------------------------------------------------------
create table if not exists user_dashboard_access (
  email      text not null references allowed_users(email) on update cascade on delete cascade,
  dashboard  text not null check (dashboard in
               ('indicadores','dre','inadimplencia','vendas','projetos','fluxo','participacoes','plantel',
                'saldo_bancario','controle_pagamentos')),
  granted_at timestamptz not null default now(),
  primary key (email, dashboard)
);

-- A check acima só vale na CRIAÇÃO: `create table if not exists` não altera tabela
-- que já existe. Dashboard novo (foi o caso de 'vendas') precisa da constraint
-- recriada, senão o insert do admin volta como violação de check.
--
-- Esta é a ÚNICA lista de painéis do hub. Painel novo se adiciona aqui, nos dois
-- lugares — nunca redefinindo a constraint no arquivo do próprio painel: a lista
-- passaria a existir em dois arquivos e quem rodasse por último apagaria o painel
-- do outro, sem erro nenhum na hora.
alter table user_dashboard_access drop constraint if exists user_dashboard_access_dashboard_check;
alter table user_dashboard_access add constraint user_dashboard_access_dashboard_check
  check (dashboard in
          ('indicadores','dre','inadimplencia','vendas','projetos','fluxo','participacoes','plantel',
           'saldo_bancario','controle_pagamentos'));

-- ---------------------------------------------------------------------
-- 3) Helpers. SECURITY DEFINER para as policies não recursarem na própria
--    tabela (policy de allowed_users consultando allowed_users = loop).
-- ---------------------------------------------------------------------
create or replace function public.hub_email() returns text
language sql stable as $$ select lower(auth.jwt() ->> 'email') $$;

create or replace function public.hub_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from allowed_users
    where email = public.hub_email() and role = 'admin' and ativo
  )
$$;

create or replace function public.hub_is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from allowed_users where email = public.hub_email() and ativo
  )
$$;

-- Pode ver este dashboard? admin vê tudo; user precisa da linha liberada.
create or replace function public.hub_can(dash text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.hub_is_admin() or exists (
    select 1
      from user_dashboard_access a
      join allowed_users u on u.email = a.email
     where a.email = public.hub_email() and a.dashboard = dash and u.ativo
  )
$$;

-- ---------------------------------------------------------------------
-- 4) RLS. Usuário lê a própria linha (pra saber o que pode abrir);
--    admin lê e escreve tudo (é o painel de administração).
-- ---------------------------------------------------------------------
alter table allowed_users          enable row level security;
alter table user_dashboard_access  enable row level security;

drop policy if exists au_self_select on allowed_users;
create policy au_self_select on allowed_users
  for select to authenticated
  using ( email = public.hub_email() or public.hub_is_admin() );

drop policy if exists au_admin_write on allowed_users;
create policy au_admin_write on allowed_users
  for all to authenticated
  using ( public.hub_is_admin() ) with check ( public.hub_is_admin() );

drop policy if exists uda_self_select on user_dashboard_access;
create policy uda_self_select on user_dashboard_access
  for select to authenticated
  using ( email = public.hub_email() or public.hub_is_admin() );

drop policy if exists uda_admin_write on user_dashboard_access;
create policy uda_admin_write on user_dashboard_access
  for all to authenticated
  using ( public.hub_is_admin() ) with check ( public.hub_is_admin() );

-- ---------------------------------------------------------------------
-- 5) Storage: bucket PRIVADO com os snapshots publicados pelos ETLs.
--    Nome do arquivo = <dashboard>.<ext> (indicadores.json, dre.json,
--    inadimplencia.html, vendas.html) — a policy usa o prefixo antes do ponto,
--    então dashboard novo não precisa de policy nova, só do nome certo.
--    Leitura liberada por dashboard; escrita só pela service_role
--    (o publisher), que ignora RLS — por isso não há policy de insert.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('hub-data', 'hub-data', false)
on conflict (id) do update set public = false;

drop policy if exists hub_data_read on storage.objects;
create policy hub_data_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'hub-data'
    and public.hub_can( split_part(name, '.', 1) )
  );

-- ---------------------------------------------------------------------
-- 6) app_state: um documento por painel que ESCREVE. Tabela compartilhada.
--
--      id = 'projetos'             Controle de Projetos
--      id = 'saldo_bancario'       saldo de cada conta, entradas, provisões
--      id = 'controle_pagamentos'  cadastro de fornecedores fixos
--
--    Mora AQUI, e não num arquivo por painel, porque a RLS é DA TABELA: as seis
--    policies abaixo só fazem sentido lidas juntas. Enquanto estiveram em três
--    arquivos, cada um declarou uma policy válida para a tabela inteira sem saber
--    das outras — e policies permissivas SOMAM (OR). O resultado era acesso
--    cruzado: quem tinha um painel lia e gravava o documento de todos os demais.
--
--    Por isso cada policy é amarrada ao `id` do seu documento. O `.eq('id', ...)`
--    que o front faz é escopo de cliente, não barreira: a anon key é pública e a
--    chamada pode ser feita direto na API.
--
--    Painel novo que escreve entra aqui: duas policies e um insert. Não se cria
--    arquivo por painel — foi o que produziu o furo acima.
--
--    O que NÃO entra aqui: o snapshot que os ETLs publicam, que vive no bucket
--    `hub-data` (seção 5), liberado por hub_can(split_part(name,'.',1)) — ou
--    seja, o nome do arquivo no bucket TEM de ser o id do painel.
-- ---------------------------------------------------------------------
create table if not exists app_state (
  id          text primary key,
  data        jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Sem política, a anon key NÃO acessa nada.
alter table app_state enable row level security;

-- As duas antigas (qualquer @luxor.com.br autenticado, sem passar pela allowlist
-- nem pelo RBAC) saem de cena: é isto que desliga o acesso pela URL avulsa do
-- repo controle-de-projetos.
drop policy if exists "luxor_select" on app_state;
drop policy if exists "luxor_update" on app_state;

drop policy if exists hub_projetos_select on app_state;
create policy hub_projetos_select on app_state
  for select to authenticated
  using ( id = 'projetos' and public.hub_can('projetos') );

drop policy if exists hub_projetos_update on app_state;
create policy hub_projetos_update on app_state
  for update to authenticated
  using      ( id = 'projetos' and public.hub_can('projetos') )
  with check ( id = 'projetos' and public.hub_can('projetos') );

-- Escrita liberada para quem TEM o painel, não só para admin: digitar o saldo e
-- manter o cadastro É o uso normal das duas telas.
drop policy if exists hub_saldo_bancario_select on app_state;
create policy hub_saldo_bancario_select on app_state
  for select to authenticated
  using ( id = 'saldo_bancario' and public.hub_can('saldo_bancario') );

drop policy if exists hub_saldo_bancario_update on app_state;
create policy hub_saldo_bancario_update on app_state
  for update to authenticated
  using      ( id = 'saldo_bancario' and public.hub_can('saldo_bancario') )
  with check ( id = 'saldo_bancario' and public.hub_can('saldo_bancario') );

drop policy if exists hub_controle_pagamentos_select on app_state;
create policy hub_controle_pagamentos_select on app_state
  for select to authenticated
  using ( id = 'controle_pagamentos' and public.hub_can('controle_pagamentos') );

drop policy if exists hub_controle_pagamentos_update on app_state;
create policy hub_controle_pagamentos_update on app_state
  for update to authenticated
  using      ( id = 'controle_pagamentos' and public.hub_can('controle_pagamentos') )
  with check ( id = 'controle_pagamentos' and public.hub_can('controle_pagamentos') );

-- Linha de cada painel, vazia. O conteúdo real vem do seed (sql/*.local.sql, não
-- versionado: este repo é público e colchão de conta e fornecedor com valor são
-- dado interno) e depois é mantido pela própria tela.
--
--   projetos            : lista de projetos            -> '[]'
--   saldo_bancario      : { contas, entradas, provisoes }
--   controle_pagamentos : { fornecedores }
--
-- Em saldo_bancario, a chave de `entradas` e `provisoes` é a QUARTA-FEIRA da
-- semana: a projeção sempre foi de quarta a quarta, e guardar por semana preserva
-- o histórico.
--
-- Em controle_pagamentos, (ano, cod, empresa, contagem) é a chave do batimento: o
-- mesmo fornecedor pode ter mais de um título fixo no mês, e a N-ésima linha do
-- cadastro casa com o N-ésimo título. Chave repetida faz o batimento não saber
-- qual é qual — a tela avisa antes de gravar.
insert into app_state (id, data) values
  ('projetos',            '[]'::jsonb),
  ('saldo_bancario',      '{}'::jsonb),
  ('controle_pagamentos', '{}'::jsonb)
on conflict (id) do nothing;

-- Realtime: sem isto o app sobe e salva, mas os clientes não se sincronizam —
-- sintoma difícil de diagnosticar num rebuild do zero.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_state'
  ) then
    alter publication supabase_realtime add table app_state;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 7) Auditoria de acesso (exigência LGPD p/ inadimplência; já serve p/ tudo).
-- ---------------------------------------------------------------------
create table if not exists access_log (
  id         bigserial primary key,
  email      text not null,
  dashboard  text not null,
  at         timestamptz not null default now()
);

alter table access_log enable row level security;

drop policy if exists al_insert_self on access_log;
create policy al_insert_self on access_log
  for insert to authenticated
  with check ( email = public.hub_email() and public.hub_is_allowed() );

drop policy if exists al_admin_read on access_log;
create policy al_admin_read on access_log
  for select to authenticated using ( public.hub_is_admin() );
