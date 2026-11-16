// Config PÚBLICA do Supabase.
// A anon key é pública por design — quem protege é a RLS: as tabelas senhas_* e o
// bucket `senhas` passam por hub_can('senhas') (ver sql/hub_schema.sql, seção 10), e
// o conteúdo ainda chega cifrado (a senha mestra fica só no navegador).
// NUNCA colocar a service_role / secret aqui.
window.SUPABASE_URL = "https://hjducsxcolbspbkpflom.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqZHVjc3hjb2xic3Bia3BmbG9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1Njc3MTgsImV4cCI6MjEwMDE0MzcxOH0.vMw-ATMuQWvVN5c6yB6CYP1XdZxxqiAAQsL9akCbdFM";
