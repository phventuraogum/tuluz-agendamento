-- =====================================================================
-- 🚨 CORREÇÃO URGENTE DE SEGURANÇA — Tuluz
-- =====================================================================
-- MOTIVO: auditoria detectou que a chave pública (anon) consegue LER os
-- dados pessoais de TODOS os agendamentos (nome, telefone, e-mail).
-- Qualquer pessoa na internet consegue extrair essa chave do site
-- publicado em segundos. São 1.053 registros expostos.
--
-- Rode este arquivo INTEIRO no SQL Editor do Supabase.
-- Ele é idempotente e foi ordenado para que nada trave no meio:
-- a proteção vem PRIMEIRO; o índice de deduplicação vem por último.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PASSO 0 — DIAGNÓSTICO (rode e leia o resultado antes de seguir)
-- ---------------------------------------------------------------------
-- Mostra se o RLS está realmente ligado e quais políticas existem hoje.
SELECT relname AS tabela, relrowsecurity AS rls_ligado
  FROM pg_class
 WHERE relname IN ('giras', 'agendamentos');

SELECT schemaname, tablename, policyname, roles, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename, policyname;


-- ---------------------------------------------------------------------
-- PASSO 1 — LISTA DE ADMINISTRADORES
-- ---------------------------------------------------------------------
-- Só estar "logado" NÃO pode ser suficiente para ler dados pessoais,
-- porque o cadastro público de usuários está ABERTO no seu projeto
-- (qualquer um poderia criar conta e virar "authenticated").
-- Por isso o acesso passa a depender desta lista explícita.
CREATE TABLE IF NOT EXISTS admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  criado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
-- Ninguém acessa esta tabela pela API pública (sem policy = sem acesso).
REVOKE ALL ON admins FROM anon, authenticated;

-- ⚠️ CONFIRA a lista abaixo ANTES de continuar. Devem aparecer APENAS as
-- contas da equipe do terreiro. Se aparecer algum e-mail desconhecido,
-- NÃO rode o INSERT seguinte: apague esse usuário no painel primeiro.
SELECT id, email, created_at FROM auth.users ORDER BY created_at;

-- Promove as contas hoje existentes a administradores.
INSERT INTO admins (user_id)
SELECT id FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- Função auxiliar usada pelas políticas.
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
-- pg_temp explícito no fim: sem isso o Postgres o pesquisa implicitamente
-- ANTES do schema listado, abrindo espaço para sequestro de nome de tabela.
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION is_admin() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION is_admin() TO authenticated;


-- ---------------------------------------------------------------------
-- PASSO 2 — TRAVA DE PRIVILÉGIO (defesa em profundidade)
-- ---------------------------------------------------------------------
-- Mesmo que o RLS seja desligado por acidente no futuro, o público
-- continua SEM poder ler, alterar ou apagar dados pessoais.
-- O público só precisa de INSERT (agendar).
REVOKE ALL     ON agendamentos FROM anon;
GRANT  INSERT  ON agendamentos TO   anon;

-- O público só precisa LER as giras (para ver data, vagas e capacidade).
REVOKE ALL     ON giras        FROM anon;
GRANT  SELECT  ON giras        TO   anon;


-- ---------------------------------------------------------------------
-- PASSO 3 — LIGAR O RLS (o passo que estava faltando)
-- ---------------------------------------------------------------------
ALTER TABLE giras        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agendamentos ENABLE ROW LEVEL SECURITY;

-- Sobre FORCE ROW LEVEL SECURITY (já está ligado em `agendamentos`):
-- Em tese, FORCE sujeitaria também o DONO da tabela às políticas — e as
-- funções SECURITY DEFINER (check_agendamento_valido, vagas_gira,
-- sync_ocupadas) rodam como o dono, o que poderia fazer o
-- `SELECT count(*) FROM agendamentos` do trigger enxergar ZERO linhas e
-- liberar overbooking silencioso.
-- VERIFICADO EM PRODUÇÃO (2026-08-03): não acontece neste ambiente. O
-- papel dono no Supabase tem BYPASSRLS, que prevalece sobre o FORCE —
-- vagas_gira() devolveu a contagem correta (60) com FORCE ativo. Mantido.
-- Se algum dia migrar para outro Postgres, revalide antes de confiar.
ALTER TABLE agendamentos FORCE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- PASSO 4 — POLÍTICAS (limpa as antigas e recria corretas)
-- ---------------------------------------------------------------------
-- Remove QUALQUER política pré-existente nas duas tabelas, para eliminar
-- alguma regra permissiva antiga que esteja liberando leitura ao público.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('giras', 'agendamentos')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- GIRAS: leitura pública (o site precisa); escrita só para admin.
CREATE POLICY giras_leitura_publica
  ON giras FOR SELECT
  USING (true);

CREATE POLICY giras_admin_escrita
  ON giras FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- AGENDAMENTOS: público SÓ INSERE. Ler/alterar/apagar: só admin.
-- (gira ativa e capacidade continuam garantidas pelo trigger)
CREATE POLICY agendamentos_insert_publico
  ON agendamentos FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY agendamentos_admin_total
  ON agendamentos FOR SELECT
  TO authenticated
  USING (is_admin());

CREATE POLICY agendamentos_admin_update
  ON agendamentos FOR UPDATE
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY agendamentos_admin_delete
  ON agendamentos FOR DELETE
  TO authenticated
  USING (is_admin());


-- ---------------------------------------------------------------------
-- PASSO 5 — TIRAR `agendamentos` DO REALTIME
-- ---------------------------------------------------------------------
-- O site não usa mais essa assinatura (passou a usar giras.ocupadas) e
-- ela transmite a linha inteira, com dados pessoais. Reduz exposição.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'agendamentos'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE agendamentos;
  END IF;
END $$;

-- Volta a replica identity ao padrão: sem isso, cada UPDATE/DELETE continua
-- gravando a linha inteira (com dados pessoais) no WAL sem necessidade.
ALTER TABLE agendamentos REPLICA IDENTITY DEFAULT;


-- ---------------------------------------------------------------------
-- PASSO 6 — VALIDAÇÃO (o resultado deve ser rls_ligado = true nas duas)
-- ---------------------------------------------------------------------
SELECT relname AS tabela, relrowsecurity AS rls_ligado, relforcerowsecurity AS rls_forcado
  FROM pg_class
 WHERE relname IN ('giras', 'agendamentos');


-- ---------------------------------------------------------------------
-- PASSO 7 — (OPCIONAL, RODE SEPARADO) Índice de deduplicação
-- ---------------------------------------------------------------------
-- Deixado por último DE PROPÓSITO: se falhar por duplicidade, nada da
-- proteção acima é desfeito. Rode este bloco sozinho, depois.
--
-- Primeiro veja se há duplicados:
--   SELECT gira_id, telefone, count(*)
--     FROM agendamentos
--    WHERE telefone IS NOT NULL AND telefone <> ''
--    GROUP BY gira_id, telefone HAVING count(*) > 1;
--
-- Se vier vazio, pode criar:
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_agendamento_gira_telefone
--   ON agendamentos (gira_id, telefone)
--   WHERE telefone IS NOT NULL AND telefone <> '';
