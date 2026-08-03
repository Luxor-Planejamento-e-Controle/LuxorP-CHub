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
               ('indicadores','dre','inadimplencia','vendas','projetos','fluxo','participacoes','plantel')),
  granted_at timestamptz not null default now(),
  primary key (email, dashboard)
);

-- A check acima só vale na CRIAÇÃO: `create table if not exists` não altera tabela
-- que já existe. Dashboard novo (foi o caso de 'vendas') precisa da constraint
-- recriada, senão o insert do admin volta como violação de check.
alter table user_dashboard_access drop constraint if exists user_dashboard_access_dashboard_check;
alter table user_dashboard_access add constraint user_dashboard_access_dashboard_check
  check (dashboard in
          ('indicadores','dre','inadimplencia','vendas','projetos','fluxo','participacoes','plantel'));

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
-- 6) Projetos (app_state): saiu daqui — está em `sql/projetos_schema.sql`,
--    que cria a tabela, liga o realtime e troca as policies antigas
--    (domínio aberto @luxor.com.br) pelas do hub, em hub_can('projetos').
--    Rodar DEPOIS deste arquivo e DEPOIS de semear allowed_users, senão
--    ninguém entra no Projetos.
-- ---------------------------------------------------------------------

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
