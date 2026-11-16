-- Correção da tabela de uma copa no meio da temporada (item 16 da fila da partida de teste): a trava da abertura do IPO continua
-- valendo para todo mundo, exceto para a rota de correção do admin (`POST /admin/seasons/:id/cups/:competition/correction`), que
-- liga `futbolsa.cup_correction` só dentro da própria transação (`set_config(..., true)`) e registra o antes e o depois no log do
-- admin. Só a tabela de fases (`cup_phases`) abre essa exceção; `season_rules` e `season_cups` seguem travadas.
CREATE OR REPLACE FUNCTION "futbolsa"."forbid_locked_season_values"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  season integer;
  locked timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'season_rules' THEN
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.locked_at IS NULL) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'season_values_locked: os valores da temporada % estão travados desde %', OLD.season_id, OLD.locked_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'cup_phases' AND coalesce(current_setting('futbolsa.cup_correction', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  FOREACH season IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.season_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.season_id END
  ] LOOP
    CONTINUE WHEN season IS NULL;
    SELECT r.locked_at INTO locked FROM "futbolsa"."season_rules" r WHERE r.season_id = season;
    IF locked IS NOT NULL THEN
      RAISE EXCEPTION 'season_values_locked: os valores da temporada % estão travados desde %', season, locked
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
