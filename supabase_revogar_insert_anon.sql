-- =====================================================================
-- Tuluz — Fechar a escrita direta do público (pentest F1)
-- =====================================================================
-- ⚠️ RODE ISTO SOMENTE DEPOIS de:
--   1) a Edge Function `agendar` estar no ar e testada, e
--   2) o site já estar publicado com VITE_TURNSTILE_SITE_KEY configurada
--      (ou seja, o formulário já enviando pela função).
--
-- O que faz: remove a permissão de INSERT do papel `anon` na tabela de
-- agendamentos. A partir daqui, um script que fale direto com a API REST do
-- Supabase (como o PoC do pentest) recebe "permission denied" e NÃO consegue
-- mais agendar. A Edge Function continua funcionando porque insere com a
-- SERVICE ROLE, que ignora RLS/grants.
--
-- Reversível: se algo der errado, volte com
--   GRANT INSERT ON agendamentos TO anon;
-- e o formulário volta ao fluxo direto (sem anti-bot).
-- =====================================================================

REVOKE INSERT ON agendamentos FROM anon;

-- A política de RLS de INSERT pode continuar existindo; sem o GRANT de tabela
-- ela não tem efeito para o anon. Deixamos como está para simplificar um
-- eventual rollback.

-- Verificação: liste os privilégios do anon em agendamentos (INSERT não deve
-- aparecer).
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name = 'agendamentos'
   AND grantee = 'anon'
 ORDER BY privilege_type;
