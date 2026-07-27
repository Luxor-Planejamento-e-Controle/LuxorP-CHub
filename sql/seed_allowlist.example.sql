-- MODELO. Repositório é PÚBLICO — nenhum e-mail real aqui.
-- A versão real fica em sql/seed_allowlist.local.sql (gitignorado) e no
-- Supabase. Copiar este arquivo, trocar os e-mails e rodar uma vez.

insert into allowed_users (email, nome, role) values
  ('admin@exemplo.com.br',   'Nome do Admin',   'admin'),
  ('usuario@exemplo.com.br', 'Nome do Usuário', 'user')
on conflict (email) do update
  set nome = excluded.nome, role = excluded.role, ativo = true;

-- Libera dashboards por usuário (admin não precisa: vê tudo).
insert into user_dashboard_access (email, dashboard) values
  ('usuario@exemplo.com.br', 'projetos'),
  ('usuario@exemplo.com.br', 'indicadores'),
  ('usuario@exemplo.com.br', 'dre')
on conflict do nothing;

-- Conferência:
--   select u.email, u.role, u.ativo, array_agg(a.dashboard order by a.dashboard)
--     from allowed_users u left join user_dashboard_access a on a.email = u.email
--    group by 1,2,3 order by 1;
