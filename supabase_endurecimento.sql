-- =====================================================================
-- Tuluz — Endurecimento final (roda DEPOIS de supabase_fix_seguranca.sql)
-- =====================================================================
-- O vazamento de dados pessoais já está fechado. Este arquivo trata o que
-- sobrou da auditoria: abuso do formulário público, integridade, rastro de
-- auditoria e retenção (LGPD).
--
-- Cada BLOCO é independente e idempotente. Se um falhar, os anteriores
-- continuam valendo — rode um de cada vez e leia o resultado.
--
-- ⚠️ NADA aqui quebra o formulário público. Em especial, NÃO transformamos
-- `nome_normalizado` em coluna gerada: o site envia esse campo no INSERT, e
-- coluna gerada recusaria o envio, derrubando o agendamento.
-- =====================================================================


-- ---------------------------------------------------------------------
-- BLOCO 1 — Fechar EXECUTE das funções (higiene de privilégio)
-- ---------------------------------------------------------------------
-- O Postgres concede EXECUTE a PUBLIC em toda função criada. Hoje qualquer
-- visitante consegue chamar is_admin() (devolve false, não vaza nada, mas
-- não há motivo para ficar exposto).
REVOKE EXECUTE ON FUNCTION is_admin()      FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION is_admin()      TO   authenticated;

REVOKE EXECUTE ON FUNCTION vagas_gira(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION vagas_gira(uuid) TO   anon, authenticated;

-- Estas retornam `trigger` e não são chamáveis pela API, mas o grant amplo
-- é higiene ruim.
REVOKE EXECUTE ON FUNCTION check_agendamento_valido() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sync_ocupadas()            FROM PUBLIC;


-- ---------------------------------------------------------------------
-- BLOCO 2 — search_path com pg_temp nas funções SECURITY DEFINER
-- ---------------------------------------------------------------------
-- Sem pg_temp explícito, ele é pesquisado ANTES do schema listado, o que em
-- teoria permite sequestrar a resolução de nome dentro de função que roda
-- com privilégio de dono.
ALTER FUNCTION check_agendamento_valido() SET search_path = public, pg_temp;
ALTER FUNCTION vagas_gira(uuid)           SET search_path = public, pg_temp;
ALTER FUNCTION sync_ocupadas()            SET search_path = public, pg_temp;
ALTER FUNCTION is_admin()                 SET search_path = public, pg_temp;


-- ---------------------------------------------------------------------
-- BLOCO 3 — Limites de tamanho e formato no BANCO
-- ---------------------------------------------------------------------
-- O site já limita, mas o site não é barreira: dá para falar direto com a
-- API. NOT VALID aplica a regra só a partir de agora, sem quebrar por causa
-- de linhas antigas fora do padrão.
ALTER TABLE agendamentos
  DROP CONSTRAINT IF EXISTS chk_nome_tam,
  DROP CONSTRAINT IF EXISTS chk_obs_tam,
  DROP CONSTRAINT IF EXISTS chk_email_tam,
  DROP CONSTRAINT IF EXISTS chk_tel_tam,
  DROP CONSTRAINT IF EXISTS chk_sem_html;

ALTER TABLE agendamentos
  ADD CONSTRAINT chk_nome_tam  CHECK (char_length(nome) BETWEEN 2 AND 120) NOT VALID,
  ADD CONSTRAINT chk_obs_tam   CHECK (observacoes IS NULL OR char_length(observacoes) <= 500) NOT VALID,
  ADD CONSTRAINT chk_email_tam CHECK (email IS NULL OR char_length(email) <= 254) NOT VALID,
  ADD CONSTRAINT chk_tel_tam   CHECK (telefone IS NULL OR char_length(telefone) <= 20) NOT VALID,
  -- corta o vetor de XSS/HTML na entrada, além do escape que o app já faz
  ADD CONSTRAINT chk_sem_html  CHECK (
        nome !~ '[<>]'
    AND (observacoes IS NULL OR observacoes !~ '[<>]')
  ) NOT VALID;

-- created_at precisa vir do servidor, não do cliente
ALTER TABLE agendamentos ALTER COLUMN created_at SET DEFAULT now();


-- ---------------------------------------------------------------------
-- BLOCO 4 — Telefone normalizado + deduplicação real
-- ---------------------------------------------------------------------
-- Coluna GERADA (o site não a envia, então não quebra o INSERT). Reduz a
-- dígitos e remove o DDI 55, para que (32) 99999-9999 e +5532999999999
-- sejam o MESMO valor.
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS telefone_digitos text
  GENERATED ALWAYS AS (
    regexp_replace(
      regexp_replace(COALESCE(telefone, ''), '\D', '', 'g'),
      '^55(?=\d{10,11}$)', ''
    )
  ) STORED;

-- ANTES de criar o índice, veja se a normalização revelou duplicados:
--   SELECT gira_id, telefone_digitos, count(*)
--     FROM agendamentos WHERE telefone_digitos <> ''
--    GROUP BY 1,2 HAVING count(*) > 1;
--
-- Para remover os excedentes mantendo o mais antigo:
--   WITH d AS (SELECT id, row_number() OVER (
--                PARTITION BY gira_id, telefone_digitos ORDER BY created_at) rn
--              FROM agendamentos WHERE telefone_digitos <> '')
--   DELETE FROM agendamentos WHERE id IN (SELECT id FROM d WHERE rn > 1);
--
-- Só depois, descomente:
-- DROP INDEX IF EXISTS uq_agendamento_gira_telefone;
-- CREATE UNIQUE INDEX uq_agendamento_gira_telefone
--   ON agendamentos (gira_id, telefone_digitos)
--   WHERE telefone_digitos <> '';


-- ---------------------------------------------------------------------
-- BLOCO 5 — Freio de vazão (rate limiting no banco)
-- ---------------------------------------------------------------------
-- Não substitui um CAPTCHA, mas impede o abuso trivial de encher uma gira
-- com um laço de requisições. Ajuste o teto ao movimento real do terreiro.
CREATE OR REPLACE FUNCTION freio_agendamentos()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_recentes integer;
BEGIN
  SELECT count(*) INTO v_recentes
    FROM agendamentos
   WHERE gira_id = NEW.gira_id
     AND created_at > now() - interval '1 minute';

  IF v_recentes >= 10 THEN
    RAISE EXCEPTION 'FLUXO_EXCEDIDO: muitos agendamentos em sequência. Tente novamente em instantes.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION freio_agendamentos() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_freio_agendamentos ON agendamentos;
CREATE TRIGGER trg_freio_agendamentos
BEFORE INSERT ON agendamentos
FOR EACH ROW EXECUTE FUNCTION freio_agendamentos();


-- ---------------------------------------------------------------------
-- BLOCO 6 — Contador `ocupadas` à prova de deriva
-- ---------------------------------------------------------------------
-- A versão anterior só tratava INSERT/DELETE e incrementava/decrementava.
-- Mover um agendamento de gira (UPDATE) dessincronizava os dois contadores,
-- e GREATEST(...,0) escondia o problema. Agora reconta — custa nada nesta
-- escala e elimina a classe inteira de bugs.
CREATE OR REPLACE FUNCTION sync_ocupadas()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.gira_id IS NOT NULL THEN
    UPDATE giras g
       SET ocupadas = (SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id)
     WHERE g.id = NEW.gira_id;
  END IF;

  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND OLD.gira_id IS DISTINCT FROM NEW.gira_id) THEN
    UPDATE giras g
       SET ocupadas = (SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id)
     WHERE g.id = OLD.gira_id;
  END IF;

  RETURN NULL; -- trigger AFTER: retorno é ignorado
END;
$$;
REVOKE EXECUTE ON FUNCTION sync_ocupadas() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_sync_ocupadas ON agendamentos;
CREATE TRIGGER trg_sync_ocupadas
AFTER INSERT OR DELETE OR UPDATE OF gira_id ON agendamentos
FOR EACH ROW EXECUTE FUNCTION sync_ocupadas();

-- TRUNCATE não dispara trigger FOR EACH ROW e deixaria o contador congelado
CREATE OR REPLACE FUNCTION sync_ocupadas_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE giras g
     SET ocupadas = (SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id);
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION sync_ocupadas_truncate() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_sync_ocupadas_truncate ON agendamentos;
CREATE TRIGGER trg_sync_ocupadas_truncate
AFTER TRUNCATE ON agendamentos
FOR EACH STATEMENT EXECUTE FUNCTION sync_ocupadas_truncate();

-- ressincroniza agora, caso já exista deriva
UPDATE giras g
   SET ocupadas = (SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id)
 WHERE g.ocupadas IS DISTINCT FROM (SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id);


-- ---------------------------------------------------------------------
-- BLOCO 7 — Exclusão de gira em UMA transação
-- ---------------------------------------------------------------------
-- Hoje o painel faz duas chamadas HTTP: apaga agendamentos, depois a gira.
-- Se a segunda falhar, os agendamentos somem e a gira fica — perda de dados
-- sem volta. Esta função faz as duas coisas atomicamente.
CREATE OR REPLACE FUNCTION excluir_gira(p_gira_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'NAO_AUTORIZADO: apenas a equipe pode excluir giras.'
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM agendamentos WHERE gira_id = p_gira_id;
  DELETE FROM giras        WHERE id = p_gira_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION excluir_gira(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION excluir_gira(uuid) TO   authenticated;


-- ---------------------------------------------------------------------
-- BLOCO 8 — Rastro de auditoria (LGPD art. 37)
-- ---------------------------------------------------------------------
-- Hoje uma exclusão em massa é indetectável e irreversível. Sem isso, não
-- há como responder "quem acessou/apagou o quê" num incidente.
CREATE TABLE IF NOT EXISTS auditoria (
  id          bigserial PRIMARY KEY,
  tabela      text        NOT NULL,
  operacao    text        NOT NULL,
  registro_id text,
  ator        uuid        DEFAULT auth.uid(),
  dados_antes jsonb,
  em          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY;
-- Sem nenhuma policy e sem grants: ninguém lê nem apaga pela API,
-- nem o próprio admin. Só pelo SQL Editor. O rastro não pode ser apagado
-- por quem está sendo auditado.
REVOKE ALL ON auditoria FROM anon, authenticated;

CREATE OR REPLACE FUNCTION registrar_auditoria()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO auditoria (tabela, operacao, registro_id, dados_antes)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    COALESCE(OLD.id::text, NEW.id::text),
    CASE WHEN TG_OP IN ('DELETE', 'UPDATE') THEN to_jsonb(OLD) END
  );
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION registrar_auditoria() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_auditoria_agendamentos ON agendamentos;
CREATE TRIGGER trg_auditoria_agendamentos
AFTER UPDATE OR DELETE ON agendamentos
FOR EACH ROW EXECUTE FUNCTION registrar_auditoria();

DROP TRIGGER IF EXISTS trg_auditoria_giras ON giras;
CREATE TRIGGER trg_auditoria_giras
AFTER UPDATE OR DELETE ON giras
FOR EACH ROW EXECUTE FUNCTION registrar_auditoria();


-- ---------------------------------------------------------------------
-- BLOCO 9 — Retenção / anonimização (LGPD art. 15-16)
-- ---------------------------------------------------------------------
-- Dado pessoal não deve ficar guardado para sempre. Esta função anonimiza
-- agendamentos de giras antigas, preservando as métricas agregadas (o painel
-- só usa id, gira_id e primeira_visita).
-- Rode manualmente a cada semestre, ou agende com pg_cron se estiver ativo.
CREATE OR REPLACE FUNCTION anonimizar_antigos(p_meses integer DEFAULT 12)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_qtd integer;
BEGIN
  UPDATE agendamentos a
     SET nome = 'Removido',
         nome_normalizado = 'removido',
         telefone = NULL,
         email = NULL,
         observacoes = NULL
    FROM giras g
   WHERE a.gira_id = g.id
     AND g.data < (current_date - make_interval(months => p_meses))
     AND a.nome <> 'Removido';
  GET DIAGNOSTICS v_qtd = ROW_COUNT;
  RETURN v_qtd;
END;
$$;
REVOKE EXECUTE ON FUNCTION anonimizar_antigos(integer) FROM PUBLIC;
-- Uso:  SELECT anonimizar_antigos(12);


-- ---------------------------------------------------------------------
-- BLOCO 10 — (OPCIONAL) Esconder do público as giras não divulgadas
-- ---------------------------------------------------------------------
-- Hoje o público lê TODAS as giras, inclusive inativas e datas futuras ainda
-- não anunciadas. Não é dado pessoal, mas é planejamento interno exposto.
-- ⚠️ Rode só depois de confirmar que a equipe está em `admins`, senão o
-- painel passa a mostrar apenas as giras ativas.
-- DROP POLICY IF EXISTS giras_leitura_publica ON giras;
-- CREATE POLICY giras_leitura_publica ON giras
--   FOR SELECT TO anon USING (ativa = true);
-- CREATE POLICY giras_leitura_equipe ON giras
--   FOR SELECT TO authenticated USING (true);


-- ---------------------------------------------------------------------
-- VALIDAÇÃO FINAL
-- ---------------------------------------------------------------------
SELECT relname AS tabela, relrowsecurity AS rls_ligado
  FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
 ORDER BY relname;

SELECT tablename, policyname, cmd, roles
  FROM pg_policies WHERE schemaname = 'public'
 ORDER BY tablename, policyname;

SELECT g.titulo, g.ocupadas,
       (SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id) AS real
  FROM giras g
 WHERE g.ocupadas IS DISTINCT FROM (SELECT count(*) FROM agendamentos a WHERE a.gira_id = g.id);
