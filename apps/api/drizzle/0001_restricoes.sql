-- Restrições que o Drizzle não gera (Plano do banco, T3). Escrita à mão.

-- Histórico que não se apaga nem se edita (Arquitetura da Fase 1, "Modelo de dados").
-- Gatilho por comando, e não por linha: pega também o comando que não acha linha e o TRUNCATE.
CREATE FUNCTION "futbolsa"."forbid_history_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'history_immutable: %.% é histórico e não aceita %', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "wallet_entries_history" BEFORE UPDATE OR DELETE OR TRUNCATE ON "futbolsa"."wallet_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "futbolsa"."forbid_history_change"();
--> statement-breakpoint
CREATE TRIGGER "trades_history" BEFORE UPDATE OR DELETE OR TRUNCATE ON "futbolsa"."trades"
  FOR EACH STATEMENT EXECUTE FUNCTION "futbolsa"."forbid_history_change"();
--> statement-breakpoint
CREATE TRIGGER "payout_holdings_history" BEFORE UPDATE OR DELETE OR TRUNCATE ON "futbolsa"."payout_holdings"
  FOR EACH STATEMENT EXECUTE FUNCTION "futbolsa"."forbid_history_change"();
--> statement-breakpoint
CREATE TRIGGER "payout_credits_history" BEFORE UPDATE OR DELETE OR TRUNCATE ON "futbolsa"."payout_credits"
  FOR EACH STATEMENT EXECUTE FUNCTION "futbolsa"."forbid_history_change"();
--> statement-breakpoint
CREATE TRIGGER "admin_log_history" BEFORE UPDATE OR DELETE OR TRUNCATE ON "futbolsa"."admin_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "futbolsa"."forbid_history_change"();
--> statement-breakpoint
CREATE TRIGGER "ranking_rows_history" BEFORE UPDATE OR DELETE OR TRUNCATE ON "futbolsa"."ranking_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "futbolsa"."forbid_history_change"();
--> statement-breakpoint

-- Valores da temporada fixos da abertura do IPO ao encerramento (Dividendos e recompra):
-- com season_rules.locked_at preenchido, nada muda em season_rules, cup_phases e season_cups
-- daquela temporada. Gravar o locked_at (de vazio para preenchido) é permitido uma vez.
CREATE FUNCTION "futbolsa"."forbid_locked_season_values"() RETURNS trigger
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
--> statement-breakpoint
CREATE TRIGGER "season_rules_locked" BEFORE UPDATE OR DELETE ON "futbolsa"."season_rules"
  FOR EACH ROW EXECUTE FUNCTION "futbolsa"."forbid_locked_season_values"();
--> statement-breakpoint
CREATE TRIGGER "cup_phases_locked" BEFORE INSERT OR UPDATE OR DELETE ON "futbolsa"."cup_phases"
  FOR EACH ROW EXECUTE FUNCTION "futbolsa"."forbid_locked_season_values"();
--> statement-breakpoint
CREATE TRIGGER "season_cups_locked" BEFORE INSERT OR UPDATE OR DELETE ON "futbolsa"."season_cups"
  FOR EACH ROW EXECUTE FUNCTION "futbolsa"."forbid_locked_season_values"();
--> statement-breakpoint

-- Clube listado tem ticker: a trava do motor de ordens ordena os clubes por ele.
CREATE FUNCTION "futbolsa"."require_listed_ticker"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT c.ticker FROM "futbolsa"."clubs" c WHERE c.id = NEW.club_id) IS NULL THEN
    RAISE EXCEPTION 'club_without_ticker: o clube % não tem ticker e não pode ser listado', NEW.club_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "season_clubs_ticker" BEFORE INSERT OR UPDATE OF "club_id" ON "futbolsa"."season_clubs"
  FOR EACH ROW EXECUTE FUNCTION "futbolsa"."require_listed_ticker"();
