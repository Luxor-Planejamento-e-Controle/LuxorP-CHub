-- =====================================================================
-- Projetos (app_state) — schema canônico, já sob o controle de acesso do hub.
--
-- Substitui o antigo `supabase_schema.sql` do repo `controle-de-projetos`,
-- cujas policies liberavam qualquer e-mail @luxor.com.br autenticado —
-- ou seja, ignoravam a allowlist e o RBAC por dashboard. Aqui a autorização
-- passa por `public.hub_can('projetos')`, o mesmo porteiro do resto do hub.
--
-- DDL apenas. Nenhum dado real. Rodar no SQL editor do projeto Supabase do hub.
--
-- PRÉ-CONDIÇÃO: rodar `hub_schema.sql` primeiro e semear `allowed_users`
-- (e `user_dashboard_access` com dashboard='projetos' para quem não é admin).
-- Aplicar isto antes do seed = ninguém abre o Projetos, nem você.
-- Idempotente: pode rodar de novo sem efeito colateral.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Tabela: 1 linha por "documento". O dashboard usa id = 'projetos'.
-- ---------------------------------------------------------------------
create table if not exists app_state (
  id          text primary key,
  data        jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2) RLS ligada. Sem política, a anon key NÃO acessa nada.
-- ---------------------------------------------------------------------
alter table app_state enable row level security;

-- ---------------------------------------------------------------------
-- 3) Policies do hub. As duas antigas (domínio aberto) saem de cena —
--    é isto que desliga o acesso pela URL avulsa do controle-de-projetos.
-- ---------------------------------------------------------------------
drop policy if exists "luxor_select" on app_state;
drop policy if exists "luxor_update" on app_state;

drop policy if exists hub_projetos_select on app_state;
create policy hub_projetos_select on app_state
  for select to authenticated
  using ( public.hub_can('projetos') );

drop policy if exists hub_projetos_update on app_state;
create policy hub_projetos_update on app_state
  for update to authenticated
  using      ( public.hub_can('projetos') )
  with check ( public.hub_can('projetos') );

-- ---------------------------------------------------------------------
-- 4) Linha única do dashboard (vazia). O dado real vive na tabela;
--    NÃO existe seed versionado — este repo é público.
-- ---------------------------------------------------------------------
insert into app_state (id, data) values ('projetos', '[]'::jsonb)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 5) Realtime: publica a tabela para o dashboard receber mudanças ao vivo.
--    Sem isto o app sobe e salva, mas os clientes não se sincronizam —
--    sintoma difícil de diagnosticar num rebuild do zero.
-- ---------------------------------------------------------------------
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
-- 6) Conferência. Esperado: as duas policies hub_projetos_*, nenhuma luxor_*,
--    e app_state na publication do realtime.
-- ---------------------------------------------------------------------
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'app_state' order by policyname;
--
-- select 1 from pg_publication_tables
--  where pubname = 'supabase_realtime' and tablename = 'app_state';
