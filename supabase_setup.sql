-- =====================================================================
-- Tuluz — Agendamento de Giras · Setup do banco (Supabase / Postgres)
-- Rode este script inteiro no SQL Editor do Supabase. É idempotente:
-- pode rodar de novo sem quebrar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TRIGGER DE INTEGRIDADE: gira ativa + CAPACIDADE (anti-overbooking)
-- ---------------------------------------------------------------------
-- Faz, em uma única função e ANTES de inserir o agendamento:
--   a) trava a linha da gira (SELECT ... FOR UPDATE) para SERIALIZAR a
--      disputa pela última vaga entre requisições concorrentes;
--   b) garante que a gira existe e está ativa;
--   c) conta os agendados e bloqueia se a capacidade já foi atingida.
--
-- A trava é o ponto-chave: sem ela, duas pessoas enviando ao mesmo tempo
-- na última vaga passariam as duas (o controle no navegador não segura).
CREATE OR REPLACE FUNCTION check_agendamento_valido()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY DEFINER: roda com os privilégios do dono da função (bypassa o RLS),
-- para que a contagem interna de agendados funcione mesmo com RLS ligado
-- bloqueando a leitura da tabela para o público.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_capacidade integer;
    v_ativa      boolean;
    v_ocupadas   integer;
BEGIN
    -- (a) trava a linha da gira até o fim da transação
    SELECT capacidade, ativa
      INTO v_capacidade, v_ativa
      FROM giras
     WHERE id = NEW.gira_id
     FOR UPDATE;

    -- (b) gira precisa existir e estar ativa
    IF NOT FOUND THEN
        RAISE EXCEPTION 'GIRA_INEXISTENTE: esta gira não existe.'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_ativa IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'GIRA_INATIVA: esta gira não está aberta para agendamento.'
            USING ERRCODE = 'P0001';
    END IF;

    -- (c) capacidade: conta os já agendados nesta gira
    SELECT count(*)
      INTO v_ocupadas
      FROM agendamentos
     WHERE gira_id = NEW.gira_id;

    IF v_ocupadas >= v_capacidade THEN
        RAISE EXCEPTION 'CAPACIDADE_ATINGIDA: as vagas para esta gira já foram preenchidas.'
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

-- Remove o trigger antigo (só gira ativa) e o novo, para recriar limpo
DROP TRIGGER IF EXISTS trg_check_gira_ativa ON agendamentos;
DROP TRIGGER IF EXISTS trg_check_agendamento_valido ON agendamentos;

CREATE TRIGGER trg_check_agendamento_valido
BEFORE INSERT ON agendamentos
FOR EACH ROW
EXECUTE FUNCTION check_agendamento_valido();


-- ---------------------------------------------------------------------
-- 2. HABILITAR REALTIME: Supabase envia avisos de mudança para o site
-- ---------------------------------------------------------------------
-- Realtime em 'giras' (capacidade/ativa) e em 'agendamentos' para que a
-- contagem de vagas atualize ao vivo quando alguém agenda.
ALTER TABLE giras REPLICA IDENTITY FULL;
ALTER TABLE agendamentos REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'giras'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE giras;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'agendamentos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE agendamentos;
  END IF;
END $$;
