-- =====================================================================
-- Tuluz — Contador `ocupadas` em giras (realtime confiável sob RLS)
-- =====================================================================
-- PROBLEMA: com o RLS ligado, o público (anon) não pode ler `agendamentos`,
-- então o Realtime dessa tabela não entrega eventos para o site público e a
-- contagem de vagas só atualizava no refresh.
--
-- SOLUÇÃO: manter um contador desnormalizado `ocupadas` na tabela `giras`
-- (que o público PODE ler), atualizado por trigger a cada agendamento
-- inserido/removido. Assim o Realtime de `giras` entrega a atualização ao
-- vivo, sem expor nenhum dado pessoal.
--
-- Idempotente: pode rodar de novo sem quebrar.
-- =====================================================================

-- 1. Coluna contadora
ALTER TABLE giras
  ADD COLUMN IF NOT EXISTS ocupadas integer NOT NULL DEFAULT 0;

-- 2. Backfill com a contagem real atual
UPDATE giras g
   SET ocupadas = COALESCE((
     SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id
   ), 0);

-- 3. Função que mantém o contador (SECURITY DEFINER para poder atualizar
--    `giras` mesmo quando o INSERT vem do público via anon).
CREATE OR REPLACE FUNCTION sync_ocupadas()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE giras SET ocupadas = ocupadas + 1 WHERE id = NEW.gira_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE giras SET ocupadas = GREATEST(ocupadas - 1, 0) WHERE id = OLD.gira_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- 4. Trigger AFTER (depois do INSERT já validado pelo trigger de capacidade)
DROP TRIGGER IF EXISTS trg_sync_ocupadas ON agendamentos;
CREATE TRIGGER trg_sync_ocupadas
AFTER INSERT OR DELETE ON agendamentos
FOR EACH ROW
EXECUTE FUNCTION sync_ocupadas();

-- 5. Garante que `giras` está no Realtime (o setup já faz, aqui é reforço)
ALTER TABLE giras REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'giras'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE giras;
  END IF;
END $$;
