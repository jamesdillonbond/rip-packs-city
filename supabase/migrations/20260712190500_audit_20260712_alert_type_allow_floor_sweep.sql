-- Allow the new 'floor_sweep' alert_type (Top Shot bulk-buy / Quick Buy sweep
-- detector, migration 20260712190000) through the topshot_insider_alerts CHECK.
-- Revert: restore the prior 7-value list (drop 'floor_sweep').

ALTER TABLE public.topshot_insider_alerts
  DROP CONSTRAINT IF EXISTS topshot_insider_alerts_alert_type_check;

ALTER TABLE public.topshot_insider_alerts
  ADD CONSTRAINT topshot_insider_alerts_alert_type_check
  CHECK (alert_type = ANY (ARRAY[
    'cluster_buyback'::text,
    'low_serial_buyback'::text,
    'set_concentration'::text,
    'unusual_edition_volume'::text,
    'floor_drop'::text,
    'concentration_buy'::text,
    'early_buyer'::text,
    'floor_sweep'::text
  ]));
