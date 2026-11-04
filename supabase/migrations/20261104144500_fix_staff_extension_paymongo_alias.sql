-- Avoid colliding with the settlement function's PL/pgSQL row variable `x`.
-- PostgreSQL otherwise treats `x.intent_id` in the SQL alias as ambiguous.
do $migration$
declare
  v_definition text;
  v_updated text;
  v_old text := 'exists(select 1 from internal.staff_booking_extension_checkouts x where x.intent_id=a.intent_id)';
  v_new text := 'exists(select 1 from internal.staff_booking_extension_checkouts ext where ext.intent_id=a.intent_id)';
begin
  v_definition := pg_catalog.pg_get_functiondef(
    'public.record_paymongo_paid(text,text,text,bigint,bigint,bigint)'::regprocedure
  );
  if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'PayMongo extension branch changed; review the alias fix before applying';
  end if;
  v_updated := replace(v_definition, v_old, v_new);
  execute v_updated;
end;
$migration$;
