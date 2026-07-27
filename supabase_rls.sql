-- =====================================================================
-- Tuluz — RLS (Row Level Security) + função de vagas + índice único
-- =====================================================================
-- PROTEGE OS DADOS PESSOAIS dos agendados (nome, telefone, e-mail),
-- que hoje ficam legíveis por qualquer um com a anon key.
--
-- ⚠️ ORDEM DE EXECUÇÃO (importante para não se trancar do lado de fora):
--   1) Crie o usuário admin em: Supabase → Authentication → Users → Add user
--      (defina e-mail + senha; marque "Auto confirm user").
--      É com esse e-mail/senha que a equipe entra em /admin agora.
--   2) Rode o supabase_setup.sql (trigger de capacidade + realtime).
--   3) Rode ESTE arquivo.
--   4) Publique o frontend novo (login por e-mail/senha + contagem via RPC).
--
-- Depois do RLS ligado:
--   • Público (anon): só INSERE agendamento e LÊ giras. Não lê a lista de
--     agendados. A contagem de vagas passa pela função vagas_gira().
--   • Equipe (authenticated): lê/edita tudo normalmente no /admin.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Função de contagem pública de vagas (SECURITY DEFINER)
-- ---------------------------------------------------------------------
-- Permite ao público saber quantas vagas foram preenchidas SEM expor os
-- dados dos agendados. Roda com privilégios do dono → bypassa o RLS.
CREATE OR REPLACE FUNCTION vagas_gira(p_gira_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::int
    FROM agendamentos
   WHERE gira_id = p_gira_id;
$$;

GRANT EXECUTE ON FUNCTION vagas_gira(uuid) TO anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. Índice único: 1 agendamento por telefone por gira (dedupe no banco)
-- ---------------------------------------------------------------------
-- Substitui a checagem feita só no navegador. Parcial: ignora telefone
-- vazio/nulo. Se ESTA linha falhar por já existirem duplicados na base,
-- limpe os duplicados antes de rodar novamente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agendamento_gira_telefone
  ON agendamentos (gira_id, telefone)
  WHERE telefone IS NOT NULL AND telefone <> '';


-- ---------------------------------------------------------------------
-- 3. Habilita RLS
-- ---------------------------------------------------------------------
ALTER TABLE giras         ENABLE ROW LEVEL SECURITY;
ALTER TABLE agendamentos  ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- 4. Políticas de GIRAS
--    Leitura pública (o site precisa mostrar a gira ativa);
--    escrita só para a equipe autenticada.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS giras_select_publico ON giras;
CREATE POLICY giras_select_publico
  ON giras FOR SELECT
  USING (true);

DROP POLICY IF EXISTS giras_admin_escrita ON giras;
CREATE POLICY giras_admin_escrita
  ON giras FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ---------------------------------------------------------------------
-- 5. Políticas de AGENDAMENTOS
--    Público pode INSERIR (agendar), mas NÃO pode ler/editar/excluir.
--    (As regras de gira ativa e capacidade ficam no trigger.)
--    Equipe autenticada faz tudo.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS agendamentos_insert_publico ON agendamentos;
CREATE POLICY agendamentos_insert_publico
  ON agendamentos FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS agendamentos_admin_leitura ON agendamentos;
CREATE POLICY agendamentos_admin_leitura
  ON agendamentos FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS agendamentos_admin_update ON agendamentos;
CREATE POLICY agendamentos_admin_update
  ON agendamentos FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS agendamentos_admin_delete ON agendamentos;
CREATE POLICY agendamentos_admin_delete
  ON agendamentos FOR DELETE
  TO authenticated
  USING (true);
