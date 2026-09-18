-- =====================================================================
-- Cadastro das contas do painel de Saldo Bancário — EXEMPLO.
--
-- Os valores abaixo são FICTÍCIOS. Colchão de conta bancária e número de
-- conta corrente são informação interna, e este repositório é público — o
-- cadastro real vive só no Supabase, como a allowlist (ver
-- seed_allowlist.example.sql, mesmo padrão).
--
-- O cadastro real é gerado a partir da planilha por `gerar_cadastro_hub.py`
-- (repositório Automacoes, pasta "Alterdata/Saldo Bancário"), que grava o SQL
-- fora de qualquer repo de propósito.
--
-- Rodar UMA vez, depois de `hub_schema.sql`. Sem isso o painel abre
-- avisando que não há conta cadastrada.
-- =====================================================================

-- O documento é um jsonb só, com duas chaves:
--
--   contas    cadastro de cada conta corrente e as aplicações dela
--   entradas  o que foi digitado, por semana (a quarta-feira de referência).
--             Preenchido pela própria tela; não faz parte do seed.
--
-- CADA CONTA CORRENTE É DONA DAS SUAS APLICAÇÕES. Isso espelha a planilha, e
-- não é detalhe de modelagem: uma empresa tem conta no Itaú e no BTG, cada uma
-- com o CDB/Tesouro dela. Uma aplicação por BANCO, compartilhada, deixaria o
-- painel mais pobre que o original e faria o "Total aplicado" somar o mesmo
-- dinheiro uma vez por conta.
--
-- Sobre `colchao`, que é o que a regra usa para decidir:
--   valor  -> conta sob a regra: abaixo dele, o painel sugere resgate
--   0      -> conta em descontinuação: sugere resgate se faltar, mas NUNCA
--             sugere aplicação (não se aplica dinheiro numa conta que vai fechar)
--   null   -> fora da regra: mostra o saldo e não sugere movimentação
--
-- Sobre `investimentos[].tipo`:
--   aplicacao  entra no "Total aplicado" e pode ser o par de resgate/aplicação
--   conta      outra conta corrente pendurada ali, que o painel mostra marcada
--              como "conta, não aplicação" e não trata como destino
--
-- O par de resgate é escolhido pelo NOME: "TESOURO SELIC" quando a conta é do
-- BTG, "CDB" nos demais. Por isso a conta do BTG que tem um fundo listado antes
-- do Tesouro continua caindo no Tesouro, e não no fundo.

update app_state
   set data = jsonb_build_object(
         'contas', '[
           {"chave":"EMPRESA UM", "conta":"Empresa Um - Itau (c/c:00000-0)",
            "banco":"ITAU", "colchao":10000, "ativa":true,
            "investimentos":[{"nome":"Empresa Um - Itau CDB-DI","tipo":"aplicacao","banco":"ITAU"}]},

           {"chave":"EMPRESA UM - BTG", "conta":"Empresa Um - BTG",
            "banco":"BTG", "colchao":0, "ativa":true,
            "investimentos":[{"nome":"Empresa Um - BTG Fundo Exemplo","tipo":"aplicacao","banco":"BTG"},
                             {"nome":"Empresa Um - BTG Tesouro Selic","tipo":"aplicacao","banco":"BTG"}]},

           {"chave":"EMPRESA DOIS", "conta":"Empresa Dois - Itau",
            "banco":"ITAU", "colchao":20000, "ativa":true,
            "investimentos":[{"nome":"Empresa Dois - Itau CDB-DI","tipo":"aplicacao","banco":"ITAU"}]},

           {"chave":"EMPRESA TRES", "conta":"Empresa Tres - Sicredi",
            "banco":"SICREDI", "colchao":10000, "ativa":true,
            "investimentos":[{"nome":"Empresa Tres - Sicredi CDB-DI","tipo":"aplicacao","banco":"SICREDI"},
                             {"nome":"Empresa Tres - Outro Banco","tipo":"conta","banco":""}]}
         ]'::jsonb,
         'entradas', coalesce(data->'entradas', '{}'::jsonb)
       ),
       updated_at = now()
 where id = 'saldo_bancario';

-- `coalesce` preserva o que já foi digitado: recadastrar uma conta não pode
-- apagar o histórico de saldos das semanas anteriores.

-- Conferir:
--   select jsonb_array_length(data->'contas') as contas,
--          (select count(*) from jsonb_object_keys(data->'entradas')) as semanas
--     from app_state where id = 'saldo_bancario';
