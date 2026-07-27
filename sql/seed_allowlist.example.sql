-- Seed da allowlist. NÃO versionar a versão com e-mails reais —
-- rodar direto no SQL editor do Supabase (os e-mails não vivem no Git).
--
-- Copiar, trocar pelos 9 e-mails e rodar uma vez.

insert into allowed_users (email, nome, role) values
  ('usuario1@exemplo.com', 'Arthur Martins', 'admin'),
  ('fulano@luxor.com.br',         'Fulano',         'user')
on conflict (email) do update
  set nome = excluded.nome, role = excluded.role, ativo = true;

-- Libera dashboards por usuário (admin não precisa: vê tudo).
insert into user_dashboard_access (email, dashboard) values
  ('fulano@luxor.com.br', 'projetos'),
  ('fulano@luxor.com.br', 'indicadores'),
  ('fulano@luxor.com.br', 'dre')
on conflict do nothing;

-- Conferência:
--   select u.email, u.role, u.ativo, array_agg(a.dashboard order by a.dashboard)
--     from allowed_users u left join user_dashboard_access a on a.email = u.email
--    group by 1,2,3 order by 1;
