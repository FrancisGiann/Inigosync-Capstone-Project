-- Keep the authoritative database gates aligned with all methods offered by
-- PayMongo hosted checkout. Wallet-only configurations are valid when the
-- owner enables Maya or GrabPay while disabling Card, GCash, and QR Ph.
alter table public.app_settings
  drop constraint if exists app_settings_online_method_required;
alter table public.app_settings
  add constraint app_settings_online_method_required
  check (card_enabled or gcash_enabled or maya_enabled or grab_pay_enabled or qrph_enabled);

do $migration$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated text;
  v_old text;
  v_new text := '(s.card_enabled or s.gcash_enabled or s.qrph_enabled
      or s.maya_enabled or s.grab_pay_enabled)';
begin
  foreach v_signature in array array[
    'public.prepare_paid_checkout_cart(uuid,jsonb,text)'::regprocedure,
    'public.staff_create_walkin_order(uuid,text,text,jsonb,text)'::regprocedure
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    v_old := '(s.card_enabled or s.gcash_enabled or s.qrph_enabled)';
    if position(v_old in v_definition) = 0 then
      v_old := '(s.card_enabled or s.gcash_enabled)';
    end if;
    if position(v_old in v_definition) = 0 then
      raise exception 'Online method gate changed for %, review wallet support', v_signature;
    end if;
    v_updated := replace(v_definition, v_old, v_new);
    if v_updated = v_definition then
      raise exception 'Could not update online method gate for %', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$migration$;
