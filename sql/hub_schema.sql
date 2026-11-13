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
                'saldo_bancario','controle_pagamentos','tarituba','kanban','societario','comite_fo','board_fo')),
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
           'saldo_bancario','controle_pagamentos','tarituba','kanban','societario','comite_fo','board_fo'));

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
--      id = 'tarituba'             cadastro de naturezas do Fluxo de Caixa Tarituba
--
--    Mora AQUI, e não num arquivo por painel, porque a RLS é DA TABELA: as oito
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
--
--    Nem o Kanban (seção 8): são milhares de cards, itens e comentários editados
--    por várias pessoas ao mesmo tempo. Num documento só, cada card arrastado
--    regravaria o board inteiro e a guarda de concorrência recusaria quase tudo.
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

-- Quem vê a aba Tarituba mantém o cadastro dela, como no Controle de Pagamentos
-- (decisão do Leonardo, 16/10/2026): sem tabela de editores à parte.
drop policy if exists hub_tarituba_select on app_state;
create policy hub_tarituba_select on app_state
  for select to authenticated
  using ( id = 'tarituba' and public.hub_can('tarituba') );

drop policy if exists hub_tarituba_update on app_state;
create policy hub_tarituba_update on app_state
  for update to authenticated
  using      ( id = 'tarituba' and public.hub_can('tarituba') )
  with check ( id = 'tarituba' and public.hub_can('tarituba') );

-- Linha de cada painel, vazia. O conteúdo real vem do seed (sql/*.local.sql, não
-- versionado: este repo é público e colchão de conta e fornecedor com valor são
-- dado interno) e depois é mantido pela própria tela.
--
--   projetos            : lista de projetos            -> '[]'
--   saldo_bancario      : { contas, entradas, provisoes }
--   controle_pagamentos : { fornecedores }
--   tarituba            : { versao, naturezas }  — ver assets/tarituba/tt_dados.js
--
-- Em tarituba, o documento vazio mantém o painel na estrutura da planilha: o job do
-- Azure só passa a ler o cadastro quando ele tem naturezas. O seed (gerado por
-- `cadastro_tarituba.py` no repo Automacoes) só grava se a linha ainda estiver vazia.
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
  ('controle_pagamentos', '{}'::jsonb),
  ('tarituba',            '{}'::jsonb)
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


-- ---------------------------------------------------------------------
-- 8) Kanban Planejamento, Controle e Concierge — o board de mesmo nome que
--    vivia no Trello, trazido para o hub em
--    11/2026 por tools/import_trello_kanban.py, com o arquivado junto.
--
--    Tabelas próprias, e não um documento em app_state (ver seção 6).
--
--    Acesso: tudo passa por hub_can('kanban'). Quem vê a aba mexe no board,
--    como no Trello, onde todo mundo era membro "normal". Exceções:
--      - comentário: só o autor edita ou apaga (admin também);
--      - histórico (kanban_atividade): só leitura. Quem escreve são os
--        gatilhos abaixo, com o e-mail do JWT.
--    Autor de card, comentário e anexo também sai do JWT, num gatilho, e não
--    do que o navegador manda: a anon key é pública e a API aceitaria qualquer
--    nome no corpo do insert.
--
--    `trello_id` = id do objeto no Trello. Só as linhas importadas têm, e é a
--    chave do upsert da importação (rodar de novo não duplica). Linha criada
--    no hub nasce com trello_id nulo, e o gatilho não deixa a tela mudá-lo.
--
--    A importação roda com a service_role, que não tem e-mail no JWT: os
--    gatilhos reconhecem isso (hub_email() nulo) e não carimbam autor nem
--    histórico por cima do que veio do Trello.
-- ---------------------------------------------------------------------
create table if not exists kanban_membros (
  id         uuid primary key default gen_random_uuid(),
  trello_id  text unique,
  nome       text not null,
  usuario    text,          -- @ no Trello: as menções antigas (@fulano123) se resolvem por aqui
  email      text unique,   -- login do hub; nulo = só existe no histórico (sem conta no hub)
  criado_em  timestamptz not null default now()
);

drop trigger if exists kanban_membros_lower on kanban_membros;
create trigger kanban_membros_lower before insert or update on kanban_membros
  for each row execute function public.lower_email();

create table if not exists kanban_listas (
  id         uuid primary key default gen_random_uuid(),
  trello_id  text unique,
  nome       text not null check (btrim(nome) <> ''),
  pos        double precision not null default 65536,
  arquivada  boolean not null default false,
  criado_em  timestamptz not null default now()
);

-- No Trello as etiquetas são PESSOAS (Aline, Caroline, Mauricio...). Nome pode
-- ficar vazio, como lá: aí vale só a cor.
create table if not exists kanban_etiquetas (
  id         uuid primary key default gen_random_uuid(),
  trello_id  text unique,
  nome       text not null default '',
  cor        text,
  criado_em  timestamptz not null default now()
);

-- `pos` segue o Trello: número real, menor = mais em cima, e o card arrastado
-- recebe o ponto médio entre os vizinhos. Mover um card grava UMA linha.
create table if not exists kanban_cards (
  id                uuid primary key default gen_random_uuid(),
  trello_id         text unique,
  lista_id          uuid not null references kanban_listas(id) on delete restrict,
  nome              text not null check (btrim(nome) <> ''),
  descricao         text not null default '',
  pos               double precision not null default 65536,
  arquivado         boolean not null default false,
  arquivado_em      timestamptz,
  prazo             timestamptz,
  prazo_concluido   boolean not null default false,
  modelo            boolean not null default false,   -- "card modelo" do Trello
  criado_por        text,
  criado_por_email  text,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  trello_url        text
);
create index if not exists kanban_cards_lista on kanban_cards (lista_id, arquivado, pos);

create table if not exists kanban_card_etiquetas (
  card_id      uuid not null references kanban_cards(id) on delete cascade,
  etiqueta_id  uuid not null references kanban_etiquetas(id) on delete cascade,
  primary key (card_id, etiqueta_id)
);
create index if not exists kanban_card_etiquetas_etq on kanban_card_etiquetas (etiqueta_id);

create table if not exists kanban_card_membros (
  card_id    uuid not null references kanban_cards(id) on delete cascade,
  membro_id  uuid not null references kanban_membros(id) on delete cascade,
  primary key (card_id, membro_id)
);
create index if not exists kanban_card_membros_mbr on kanban_card_membros (membro_id);

create table if not exists kanban_checklists (
  id         uuid primary key default gen_random_uuid(),
  trello_id  text unique,
  card_id    uuid not null references kanban_cards(id) on delete cascade,
  nome       text not null default 'Checklist',
  pos        double precision not null default 65536
);
create index if not exists kanban_checklists_card on kanban_checklists (card_id);

create table if not exists kanban_checkitens (
  id            uuid primary key default gen_random_uuid(),
  trello_id     text unique,
  checklist_id  uuid not null references kanban_checklists(id) on delete cascade,
  nome          text not null,
  pos           double precision not null default 65536,
  concluido     boolean not null default false,
  membro_id     uuid references kanban_membros(id) on delete set null,
  prazo         timestamptz
);
create index if not exists kanban_checkitens_cl on kanban_checkitens (checklist_id);

create table if not exists kanban_comentarios (
  id           uuid primary key default gen_random_uuid(),
  trello_id    text unique,
  card_id      uuid not null references kanban_cards(id) on delete cascade,
  autor_nome   text,
  autor_email  text,
  texto        text not null check (btrim(texto) <> ''),
  criado_em    timestamptz not null default now(),
  editado_em   timestamptz
);
create index if not exists kanban_comentarios_card on kanban_comentarios (card_id, criado_em desc);

-- `caminho` = arquivo no bucket `kanban`; `url` = link (o Trello deixa anexar
-- link, e o board tem dois). Um dos dois sempre existe.
create table if not exists kanban_anexos (
  id           uuid primary key default gen_random_uuid(),
  trello_id    text unique,
  card_id      uuid not null references kanban_cards(id) on delete cascade,
  nome         text not null,
  caminho      text,
  url          text,
  mime         text,
  bytes        bigint,
  autor_nome   text,
  autor_email  text,
  criado_em    timestamptz not null default now(),
  pos          double precision not null default 65536,
  check (caminho is not null or url is not null)
);
create index if not exists kanban_anexos_card on kanban_anexos (card_id);

-- Capa do card: uma imagem anexada a ele (o Trello deixava, e o time trocou capa 20
-- vezes). A coluna entra depois de kanban_anexos existir.
alter table kanban_cards add column if not exists capa_anexo_id uuid
  references kanban_anexos(id) on delete set null;

-- "Seguir" o card, como no Trello: quem segue é avisado dos comentários e do prazo
-- mesmo sem ser membro. Da importação vêm os cards que o dono do token seguia.
create table if not exists kanban_seguidores (
  card_id    uuid not null references kanban_cards(id) on delete cascade,
  membro_id  uuid not null references kanban_membros(id) on delete cascade,
  primary key (card_id, membro_id)
);
create index if not exists kanban_seguidores_mbr on kanban_seguidores (membro_id);

-- Fila de avisos. Os gatilhos enfileiram; quem entrega é o Function App
-- (luxor-planejamento-functions, pasta pc_kanban), por mensagem direta no Slack, em
-- dia útil. Só a service_role lê e grava: a tela não precisa ver a fila de ninguém.
--   tipo: mencao | comentario | membro | item | prazo_vence | prazo_venceu
--   chave: só os avisos de prazo têm — um por card, prazo e pessoa, mesmo com o
--          job de prazo rodando todo dia.
create table if not exists kanban_notificacoes (
  id          uuid primary key default gen_random_uuid(),
  para_email  text not null,
  tipo        text not null,
  card_id     uuid references kanban_cards(id) on delete cascade,
  autor_nome  text,
  texto       text,
  chave       text unique,
  criado_em   timestamptz not null default now(),
  enviada_em  timestamptz,
  tentativas  integer not null default 0,
  erro        text
);
create index if not exists kanban_notificacoes_pendentes on kanban_notificacoes (criado_em)
  where enviada_em is null;

-- Histórico. `tipo` + `dados` (o que precisa para escrever a frase: listas de
-- origem e destino, nome do item, do anexo...). Do Trello vêm todos os eventos
-- menos os comentários, que já estão em kanban_comentarios. card_id nulo =
-- evento do board (lista criada, card excluído).
create table if not exists kanban_atividade (
  id           uuid primary key default gen_random_uuid(),
  trello_id    text unique,
  card_id      uuid references kanban_cards(id) on delete cascade,
  tipo         text not null,
  dados        jsonb not null default '{}'::jsonb,
  autor_nome   text,
  autor_email  text,
  criado_em    timestamptz not null default now()
);
create index if not exists kanban_atividade_card on kanban_atividade (card_id, criado_em desc);
create index if not exists kanban_atividade_data on kanban_atividade (criado_em desc);

-- ---- quem está mexendo ----
create or replace function public.kanban_autor_nome() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nome from kanban_membros where email = public.hub_email()),
    nullif(btrim((select nome from allowed_users where email = public.hub_email())), ''),
    split_part(public.hub_email(), '@', 1))
$$;

-- Garante a linha de membro de quem abriu o board (para poder ser incluído em
-- card). A importação já cria a de todo mundo que estava no Trello; esta cobre
-- quem ganhar a aba depois.
create or replace function public.kanban_entrar() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e text := public.hub_email();
  v uuid;
begin
  if e is null or not public.hub_can('kanban') then
    raise exception 'sem acesso ao kanban' using errcode = '42501';
  end if;
  select id into v from kanban_membros where email = e;
  if v is null then
    -- `usuario` é o que vai depois do @ numa menção. Quem veio do Trello mantém o de
    -- lá (as menções antigas apontam para ele); quem chega agora usa o e-mail.
    insert into kanban_membros (nome, email, usuario)
    values (public.kanban_autor_nome(), e,
            regexp_replace(split_part(e, '@', 1), '[^a-z0-9_]', '_', 'g'))
    on conflict (email) do update set email = excluded.email
    returning id into v;
  end if;
  return v;
end $$;

-- ---- histórico gravado pelo banco ----
-- `kanban.copia` fica ligado enquanto kanban_copiar_card() roda: a cópia vira UM
-- evento ("copiou de ..."), e não um por etiqueta, membro e checklist copiados.
create or replace function public.kanban_log(p_card uuid, p_tipo text, p_dados jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.hub_email() is null then return; end if;   -- service_role: o histórico veio do Trello
  -- card saindo junto (exclusão em cascata): o evento que vale é o "excluiu"
  if p_card is not null and not exists (select 1 from kanban_cards where id = p_card) then
    return;
  end if;
  insert into kanban_atividade (card_id, tipo, dados, autor_nome, autor_email)
  values (p_card, p_tipo, coalesce(p_dados, '{}'::jsonb), public.kanban_autor_nome(), public.hub_email());
end $$;

-- Enfileira um aviso para cada e-mail da lista, menos para quem fez a ação (ninguém é
-- avisado do que ele mesmo fez). Sem e-mail no JWT — importação, automação mensal —
-- não avisa ninguém.
create or replace function public.kanban_avisar(p_emails text[], p_tipo text, p_card uuid, p_texto text)
returns void language plpgsql security definer set search_path = public as $$
declare eu text := public.hub_email();
begin
  if eu is null then return; end if;
  insert into kanban_notificacoes (para_email, tipo, card_id, autor_nome, texto)
  select distinct e, p_tipo, p_card, public.kanban_autor_nome(), left(p_texto, 400)
    from unnest(p_emails) as e
   where e is not null and e <> eu;
end $$;

create or replace function public.kanban_copiando() returns boolean
language sql stable as $$ select coalesce(current_setting('kanban.copia', true), '') <> '' $$;

create or replace function public.kanban_nome_lista(p uuid) returns text
language sql stable security definer set search_path = public as $$
  select nome from kanban_listas where id = p
$$;

create or replace function public.kanban_cards_antes() returns trigger
language plpgsql security definer set search_path = public as $$
declare e text := public.hub_email();
begin
  if new.capa_anexo_id is not null and not exists (
       select 1 from kanban_anexos where id = new.capa_anexo_id and card_id = new.id) then
    raise exception 'a capa tem de ser um anexo deste card';
  end if;
  if e is null then
    -- importação: valores vêm do Trello como estão
    if new.arquivado and new.arquivado_em is null then new.arquivado_em := now(); end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.trello_id := null; new.trello_url := null;
    new.criado_por_email := e; new.criado_por := public.kanban_autor_nome();
    new.criado_em := now(); new.atualizado_em := now();
    new.arquivado_em := case when new.arquivado then now() end;
  else
    new.trello_id := old.trello_id; new.trello_url := old.trello_url;
    new.criado_por := old.criado_por; new.criado_por_email := old.criado_por_email;
    new.criado_em := old.criado_em; new.atualizado_em := now();
    if new.arquivado is distinct from old.arquivado then
      new.arquivado_em := case when new.arquivado then now() end;
    else
      new.arquivado_em := old.arquivado_em;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists kanban_cards_antes on kanban_cards;
create trigger kanban_cards_antes before insert or update on kanban_cards
  for each row execute function public.kanban_cards_antes();

create or replace function public.kanban_cards_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if public.kanban_copiando() then
      perform public.kanban_log(new.id, 'copiou', jsonb_build_object(
        'origem', current_setting('kanban.copia', true), 'lista', public.kanban_nome_lista(new.lista_id)));
    else
      perform public.kanban_log(new.id, 'criou', jsonb_build_object('lista', public.kanban_nome_lista(new.lista_id)));
    end if;
  elsif tg_op = 'UPDATE' then
    if new.lista_id is distinct from old.lista_id then
      perform public.kanban_log(new.id, 'moveu', jsonb_build_object(
        'de', public.kanban_nome_lista(old.lista_id), 'para', public.kanban_nome_lista(new.lista_id)));
    end if;
    if new.arquivado is distinct from old.arquivado then
      perform public.kanban_log(new.id, case when new.arquivado then 'arquivou' else 'restaurou' end, '{}');
    end if;
    if new.nome is distinct from old.nome then
      perform public.kanban_log(new.id, 'renomeou', jsonb_build_object('de', old.nome, 'para', new.nome));
    end if;
    if new.descricao is distinct from old.descricao then
      perform public.kanban_log(new.id, 'descricao', '{}');
    end if;
    if new.prazo is distinct from old.prazo then
      perform public.kanban_log(new.id, 'prazo', jsonb_build_object('de', old.prazo, 'para', new.prazo));
    end if;
    if new.prazo_concluido is distinct from old.prazo_concluido then
      perform public.kanban_log(new.id, 'prazo_concluido', jsonb_build_object('valor', new.prazo_concluido));
    end if;
  else
    perform public.kanban_log(null, 'excluiu', jsonb_build_object(
      'card', old.nome, 'lista', public.kanban_nome_lista(old.lista_id)));
  end if;
  return null;
end $$;

drop trigger if exists kanban_cards_depois on kanban_cards;
create trigger kanban_cards_depois after insert or update or delete on kanban_cards
  for each row execute function public.kanban_cards_depois();

create or replace function public.kanban_listas_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.kanban_log(null, 'lista_criou', jsonb_build_object('lista', new.nome));
  else
    if new.nome is distinct from old.nome then
      perform public.kanban_log(null, 'lista_renomeou', jsonb_build_object('de', old.nome, 'para', new.nome));
    end if;
    if new.arquivada is distinct from old.arquivada then
      perform public.kanban_log(null, case when new.arquivada then 'lista_arquivou' else 'lista_restaurou' end,
                                jsonb_build_object('lista', new.nome));
    end if;
  end if;
  return null;
end $$;

drop trigger if exists kanban_listas_depois on kanban_listas;
create trigger kanban_listas_depois after insert or update on kanban_listas
  for each row execute function public.kanban_listas_depois();

create or replace function public.kanban_card_membros_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.kanban_copiando() then return null; end if;
  if tg_op = 'INSERT' then
    perform public.kanban_log(new.card_id, 'membro_entrou', jsonb_build_object(
      'membro', (select nome from kanban_membros where id = new.membro_id)));
    perform public.kanban_avisar(array(select email from kanban_membros where id = new.membro_id),
                                 'membro', new.card_id, null);
  else
    perform public.kanban_log(old.card_id, 'membro_saiu', jsonb_build_object(
      'membro', (select nome from kanban_membros where id = old.membro_id)));
  end if;
  return null;
end $$;

drop trigger if exists kanban_card_membros_depois on kanban_card_membros;
create trigger kanban_card_membros_depois after insert or delete on kanban_card_membros
  for each row execute function public.kanban_card_membros_depois();

create or replace function public.kanban_card_etiquetas_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.kanban_copiando() then return null; end if;
  if tg_op = 'INSERT' then
    perform public.kanban_log(new.card_id, 'etiqueta_pos', jsonb_build_object(
      'etiqueta', (select nome from kanban_etiquetas where id = new.etiqueta_id)));
  else
    perform public.kanban_log(old.card_id, 'etiqueta_tirou', jsonb_build_object(
      'etiqueta', (select nome from kanban_etiquetas where id = old.etiqueta_id)));
  end if;
  return null;
end $$;

drop trigger if exists kanban_card_etiquetas_depois on kanban_card_etiquetas;
create trigger kanban_card_etiquetas_depois after insert or delete on kanban_card_etiquetas
  for each row execute function public.kanban_card_etiquetas_depois();

create or replace function public.kanban_checklists_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.kanban_copiando() then return null; end if;
  if tg_op = 'INSERT' then
    perform public.kanban_log(new.card_id, 'checklist_criou', jsonb_build_object('checklist', new.nome));
  else
    perform public.kanban_log(old.card_id, 'checklist_excluiu', jsonb_build_object('checklist', old.nome));
  end if;
  return null;
end $$;

drop trigger if exists kanban_checklists_depois on kanban_checklists;
create trigger kanban_checklists_depois after insert or delete on kanban_checklists
  for each row execute function public.kanban_checklists_depois();

create or replace function public.kanban_checkitens_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.concluido is distinct from old.concluido then
    perform public.kanban_log(
      (select card_id from kanban_checklists where id = new.checklist_id),
      case when new.concluido then 'item_concluido' else 'item_reaberto' end,
      jsonb_build_object('item', new.nome));
  end if;
  if new.membro_id is not null and new.membro_id is distinct from old.membro_id then
    perform public.kanban_avisar(array(select email from kanban_membros where id = new.membro_id),
                                 'item', (select card_id from kanban_checklists where id = new.checklist_id),
                                 new.nome);
  end if;
  return null;
end $$;

drop trigger if exists kanban_checkitens_depois on kanban_checkitens;
create trigger kanban_checkitens_depois after update on kanban_checkitens
  for each row execute function public.kanban_checkitens_depois();

create or replace function public.kanban_anexos_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.hub_email() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.trello_id := null;
    new.autor_email := public.hub_email(); new.autor_nome := public.kanban_autor_nome();
    new.criado_em := now();
  else
    new.trello_id := old.trello_id; new.autor_email := old.autor_email;
    new.autor_nome := old.autor_nome; new.criado_em := old.criado_em;
    new.card_id := old.card_id; new.caminho := old.caminho;
  end if;
  return new;
end $$;

drop trigger if exists kanban_anexos_antes on kanban_anexos;
create trigger kanban_anexos_antes before insert or update on kanban_anexos
  for each row execute function public.kanban_anexos_antes();

create or replace function public.kanban_anexos_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.kanban_log(new.card_id, 'anexo_incluiu', jsonb_build_object('anexo', new.nome));
  else
    perform public.kanban_log(old.card_id, 'anexo_excluiu', jsonb_build_object('anexo', old.nome));
  end if;
  return null;
end $$;

drop trigger if exists kanban_anexos_depois on kanban_anexos;
create trigger kanban_anexos_depois after insert or delete on kanban_anexos
  for each row execute function public.kanban_anexos_depois();

create or replace function public.kanban_comentarios_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.hub_email() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.trello_id := null;
    new.autor_email := public.hub_email(); new.autor_nome := public.kanban_autor_nome();
    new.criado_em := now(); new.editado_em := null;
  else
    new.trello_id := old.trello_id; new.card_id := old.card_id;
    new.autor_email := old.autor_email; new.autor_nome := old.autor_nome;
    new.criado_em := old.criado_em;
    new.editado_em := case when new.texto is distinct from old.texto then now() else old.editado_em end;
  end if;
  return new;
end $$;

drop trigger if exists kanban_comentarios_antes on kanban_comentarios;
create trigger kanban_comentarios_antes before insert or update on kanban_comentarios
  for each row execute function public.kanban_comentarios_antes();

-- Comentário novo: avisa quem foi mencionado (@usuario; @card = todos os membros do
-- card, como no Trello — 410 comentários do board usaram) e, à parte, os demais
-- membros e seguidores do card. Quem foi mencionado recebe só o aviso de menção.
create or replace function public.kanban_comentarios_avisos() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  mencionados  text[];
  participantes text[];
begin
  if public.hub_email() is null then return null; end if;
  select coalesce(array_agg(distinct mb.email), '{}') into mencionados
    from regexp_matches(new.texto, '@([A-Za-z0-9_]+)', 'g') as m(x)
    join kanban_membros mb
      on lower(mb.usuario) = lower(m.x[1])
      or (lower(m.x[1]) = 'card'
          and mb.id in (select membro_id from kanban_card_membros where card_id = new.card_id))
   where mb.email is not null;
  select coalesce(array_agg(distinct mb.email), '{}') into participantes
    from kanban_membros mb
   where mb.email is not null
     and not (mb.email = any (mencionados))
     and (mb.id in (select membro_id from kanban_card_membros where card_id = new.card_id)
          or mb.id in (select membro_id from kanban_seguidores where card_id = new.card_id));
  perform public.kanban_avisar(mencionados, 'mencao', new.card_id, new.texto);
  perform public.kanban_avisar(participantes, 'comentario', new.card_id, new.texto);
  return null;
end $$;

drop trigger if exists kanban_comentarios_avisos on kanban_comentarios;
create trigger kanban_comentarios_avisos after insert on kanban_comentarios
  for each row execute function public.kanban_comentarios_avisos();

-- Prazo: o job das 08:00 (dia útil) chama esta função. Enfileira para membros e
-- seguidores dos cards abertos cujo prazo vence nas próximas 24h ("vence") ou venceu
-- nos últimos 3 dias ("venceu" — cobre o fim de semana). A chave impede repetir o
-- mesmo aviso nos dias seguintes; prazo mudado é aviso novo.
create or replace function public.kanban_avisos_de_prazo() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into kanban_notificacoes (para_email, tipo, card_id, texto, chave)
  select distinct on (mb.email, c.id)
         mb.email,
         case when c.prazo <= now() then 'prazo_venceu' else 'prazo_vence' end,
         c.id,
         to_char(c.prazo at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'),
         'prazo:' || c.id || ':' || extract(epoch from c.prazo)::bigint || ':' || mb.email
           || case when c.prazo <= now() then ':venceu' else ':vence' end
    from kanban_cards c
    join kanban_listas l on l.id = c.lista_id and not l.arquivada
    join kanban_membros mb on mb.email is not null
     and (mb.id in (select membro_id from kanban_card_membros where card_id = c.id)
          or mb.id in (select membro_id from kanban_seguidores where card_id = c.id))
   where not c.arquivado and not c.prazo_concluido and c.prazo is not null
     and c.prazo <= now() + interval '24 hours'
     and c.prazo >  now() - interval '3 days'
  on conflict (chave) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Busca em tudo (título, descrição, comentários e itens de checklist), abertos e
-- arquivados. SECURITY INVOKER: a RLS de cada tabela vale para quem busca.
create or replace function public.kanban_buscar(p_texto text, p_limite integer default 80)
returns table (card_id uuid, nome text, lista_id uuid, arquivado boolean,
               arquivado_em timestamptz, onde text)
language sql stable security invoker set search_path = public as $$
  with t as (
    select '%' || replace(replace(replace(btrim(p_texto), '\', '\\'), '%', '\%'), '_', '\_') || '%' as p
  )
  select c.id, c.nome, c.lista_id, c.arquivado, c.arquivado_em,
         case when c.nome ilike t.p then 'título'
              when c.descricao ilike t.p then 'descrição'
              when exists (select 1 from kanban_comentarios m where m.card_id = c.id and m.texto ilike t.p)
                then 'comentário'
              else 'checklist' end
    from kanban_cards c, t
   where length(btrim(p_texto)) >= 2
     and (c.nome ilike t.p or c.descricao ilike t.p
          or exists (select 1 from kanban_comentarios m where m.card_id = c.id and m.texto ilike t.p)
          or exists (select 1 from kanban_checklists k join kanban_checkitens i on i.checklist_id = k.id
                      where k.card_id = c.id and i.nome ilike t.p))
   order by c.arquivado, coalesce(c.arquivado_em, c.atualizado_em) desc
   limit least(greatest(p_limite, 1), 300)
$$;

-- ---- copiar card ----
-- Como o "Copiar" do Trello com checklists, etiquetas e membros (o mesmo
-- keepFromSource do pc_trello, que duplica os cards do fechamento todo mês).
-- A descrição vai sempre. Os itens do checklist nascem DESMARCADOS: é o que o
-- Trello faz — nos 3.695 itens marcados de cards copiados, o clique foi sempre
-- depois da cópia. Uma transação só: não sobra card pela metade se algo falhar.
-- SECURITY INVOKER: quem chama precisa poder gravar (RLS); a service_role pode.
create or replace function public.kanban_copiar_card(
  p_origem      uuid,
  p_nome        text,
  p_lista       uuid,
  p_pos         double precision default null,
  p_checklists  boolean default true,
  p_etiquetas   boolean default true,
  p_membros     boolean default true
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  o   kanban_cards;
  v   uuid;
  cl  record;
  ncl uuid;
begin
  select * into o from kanban_cards where id = p_origem;
  if not found then raise exception 'card de origem não encontrado'; end if;

  perform set_config('kanban.copia', o.nome, true);
  insert into kanban_cards (lista_id, nome, descricao, pos)
  values (p_lista,
          coalesce(nullif(btrim(p_nome), ''), o.nome),
          o.descricao,
          coalesce(p_pos, (select coalesce(min(pos), 131072) / 2
                             from kanban_cards where lista_id = p_lista and not arquivado)))
  returning id into v;

  if p_etiquetas then
    insert into kanban_card_etiquetas (card_id, etiqueta_id)
    select v, etiqueta_id from kanban_card_etiquetas where card_id = p_origem;
  end if;
  if p_membros then
    insert into kanban_card_membros (card_id, membro_id)
    select v, membro_id from kanban_card_membros where card_id = p_origem;
  end if;
  if p_checklists then
    for cl in select * from kanban_checklists where card_id = p_origem order by pos loop
      insert into kanban_checklists (card_id, nome, pos) values (v, cl.nome, cl.pos)
      returning id into ncl;
      insert into kanban_checkitens (checklist_id, nome, pos, concluido, membro_id, prazo)
      select ncl, nome, pos, false, membro_id, prazo
        from kanban_checkitens where checklist_id = cl.id;
    end loop;
  end if;
  perform set_config('kanban.copia', '', true);
  return v;
end $$;

revoke execute on function public.kanban_entrar() from public, anon;
revoke execute on function public.kanban_copiar_card(uuid, text, uuid, double precision, boolean, boolean, boolean) from public, anon;
revoke execute on function public.kanban_buscar(text, integer) from public, anon;
revoke execute on function public.kanban_avisos_de_prazo() from public, anon, authenticated;
revoke execute on function public.kanban_avisar(text[], text, uuid, text) from public, anon, authenticated;
grant  execute on function public.kanban_entrar() to authenticated;
grant  execute on function public.kanban_copiar_card(uuid, text, uuid, double precision, boolean, boolean, boolean) to authenticated, service_role;
grant  execute on function public.kanban_buscar(text, integer) to authenticated;
grant  execute on function public.kanban_avisos_de_prazo() to service_role;

-- ---- RLS ----
-- `(select hub_can(...))` e não `hub_can(...)` direto: assim o Postgres avalia
-- uma vez por consulta, e não uma por linha — o arquivado tem mil e tantos cards
-- e o histórico, dezenas de milhares de linhas.
alter table kanban_membros         enable row level security;
alter table kanban_listas          enable row level security;
alter table kanban_etiquetas       enable row level security;
alter table kanban_cards           enable row level security;
alter table kanban_card_etiquetas  enable row level security;
alter table kanban_card_membros    enable row level security;
alter table kanban_checklists      enable row level security;
alter table kanban_checkitens      enable row level security;
alter table kanban_comentarios     enable row level security;
alter table kanban_anexos          enable row level security;
alter table kanban_atividade       enable row level security;
alter table kanban_seguidores      enable row level security;
-- fila de avisos: RLS ligada e NENHUMA policy = só a service_role (o Function App)
alter table kanban_notificacoes    enable row level security;

drop policy if exists kanban_seguidores_rw on kanban_seguidores;
create policy kanban_seguidores_rw on kanban_seguidores
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

-- membros: todos leem; nome corrigido só pelo admin; linha nova só pela
-- kanban_entrar() ou pela importação
drop policy if exists kanban_membros_select on kanban_membros;
create policy kanban_membros_select on kanban_membros
  for select to authenticated using ( (select public.hub_can('kanban')) );
drop policy if exists kanban_membros_admin on kanban_membros;
create policy kanban_membros_admin on kanban_membros
  for update to authenticated
  using ( (select public.hub_is_admin()) ) with check ( (select public.hub_is_admin()) );

drop policy if exists kanban_listas_rw on kanban_listas;
create policy kanban_listas_rw on kanban_listas
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_etiquetas_rw on kanban_etiquetas;
create policy kanban_etiquetas_rw on kanban_etiquetas
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_cards_rw on kanban_cards;
create policy kanban_cards_rw on kanban_cards
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_card_etiquetas_rw on kanban_card_etiquetas;
create policy kanban_card_etiquetas_rw on kanban_card_etiquetas
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_card_membros_rw on kanban_card_membros;
create policy kanban_card_membros_rw on kanban_card_membros
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_checklists_rw on kanban_checklists;
create policy kanban_checklists_rw on kanban_checklists
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_checkitens_rw on kanban_checkitens;
create policy kanban_checkitens_rw on kanban_checkitens
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_anexos_rw on kanban_anexos;
create policy kanban_anexos_rw on kanban_anexos
  for all to authenticated
  using ( (select public.hub_can('kanban')) ) with check ( (select public.hub_can('kanban')) );

drop policy if exists kanban_comentarios_select on kanban_comentarios;
create policy kanban_comentarios_select on kanban_comentarios
  for select to authenticated using ( (select public.hub_can('kanban')) );
drop policy if exists kanban_comentarios_insert on kanban_comentarios;
create policy kanban_comentarios_insert on kanban_comentarios
  for insert to authenticated with check ( (select public.hub_can('kanban')) );
drop policy if exists kanban_comentarios_autor on kanban_comentarios;
create policy kanban_comentarios_autor on kanban_comentarios
  for update to authenticated
  using      ( (select public.hub_can('kanban'))
               and (autor_email = (select public.hub_email()) or (select public.hub_is_admin())) )
  with check ( (select public.hub_can('kanban')) );
drop policy if exists kanban_comentarios_apagar on kanban_comentarios;
create policy kanban_comentarios_apagar on kanban_comentarios
  for delete to authenticated
  using ( (select public.hub_can('kanban'))
          and (autor_email = (select public.hub_email()) or (select public.hub_is_admin())) );

drop policy if exists kanban_atividade_select on kanban_atividade;
create policy kanban_atividade_select on kanban_atividade
  for select to authenticated using ( (select public.hub_can('kanban')) );

-- GRANT explícito: projeto Supabase novo não expõe tabela nova à API sozinho, e
-- função nova não nasce executável por todos. Sem isto, num rebuild do zero a
-- tela levaria "permission denied" antes mesmo de chegar na RLS — que continua
-- sendo a barreira de verdade. anon não recebe nada.
grant select, insert, update, delete on
  kanban_listas, kanban_etiquetas, kanban_cards, kanban_card_etiquetas, kanban_card_membros,
  kanban_checklists, kanban_checkitens, kanban_comentarios, kanban_anexos, kanban_seguidores
  to authenticated;
grant select, update on kanban_membros to authenticated;
grant select on kanban_atividade to authenticated;
grant all on
  kanban_membros, kanban_listas, kanban_etiquetas, kanban_cards, kanban_card_etiquetas,
  kanban_card_membros, kanban_checklists, kanban_checkitens, kanban_comentarios, kanban_anexos,
  kanban_atividade, kanban_seguidores, kanban_notificacoes
  to service_role;
revoke all on
  kanban_membros, kanban_listas, kanban_etiquetas, kanban_cards, kanban_card_etiquetas,
  kanban_card_membros, kanban_checklists, kanban_checkitens, kanban_comentarios, kanban_anexos,
  kanban_atividade, kanban_seguidores, kanban_notificacoes
  from anon;
revoke all on kanban_notificacoes from authenticated;
grant execute on function public.hub_email(), public.hub_is_admin(), public.hub_can(text)
  to authenticated;

-- ---- anexos: bucket PRÓPRIO, privado ----
-- Não é o hub-data: lá a leitura sai do nome do arquivo e só a service_role
-- grava. Aqui quem tem a aba anexa e apaga, como no Trello. 50 MB por arquivo
-- (o maior que veio do Trello tem 10 MB).
insert into storage.buckets (id, name, public, file_size_limit)
values ('kanban', 'kanban', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists kanban_arquivos_ler on storage.objects;
create policy kanban_arquivos_ler on storage.objects
  for select to authenticated
  using ( bucket_id = 'kanban' and (select public.hub_can('kanban')) );

drop policy if exists kanban_arquivos_enviar on storage.objects;
create policy kanban_arquivos_enviar on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'kanban' and (select public.hub_can('kanban')) );

drop policy if exists kanban_arquivos_apagar on storage.objects;
create policy kanban_arquivos_apagar on storage.objects
  for delete to authenticated
  using ( bucket_id = 'kanban' and (select public.hub_can('kanban')) );

-- Realtime: quem está com o board aberto vê o card que o colega moveu.
do $$
declare t text;
begin
  foreach t in array array['kanban_listas','kanban_etiquetas','kanban_cards','kanban_card_etiquetas',
                           'kanban_card_membros','kanban_checklists','kanban_checkitens',
                           'kanban_comentarios','kanban_anexos','kanban_seguidores'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- 9) Foto de cada pessoa: a do perfil do Slack (pedido do Arthur, 13/11/2026).
--    Vale para o avatar do topo do hub e para os do Kanban.
--
--    O login do hub é por link no e-mail, sem Google: não há foto no login para
--    pegar. Quem preenche é o Function App (luxor-planejamento-functions,
--    pc_hub_fotos), de hora em hora em dia útil, com o bot do Kanban achando cada
--    pessoa da allowlist pelo e-mail no Slack. Quem não pôs foto no Slack fica sem
--    linha aqui, e a tela mostra as iniciais.
--
--    Quem está liberado no hub lê todas (o Kanban mostra a foto dos colegas);
--    só a service_role grava.
-- ---------------------------------------------------------------------
create table if not exists hub_fotos (
  email          text primary key,
  foto_url       text not null check (foto_url ~ '^https://'),
  atualizado_em  timestamptz not null default now()
);

alter table hub_fotos enable row level security;

drop policy if exists hub_fotos_select on hub_fotos;
create policy hub_fotos_select on hub_fotos
  for select to authenticated using ( (select public.hub_is_allowed()) );

grant select on hub_fotos to authenticated;
grant all on hub_fotos to service_role;
revoke all on hub_fotos from anon;
grant execute on function public.hub_is_allowed() to authenticated;
