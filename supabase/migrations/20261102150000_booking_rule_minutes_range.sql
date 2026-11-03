-- Both owner-configurable minute rules support whole values from 0 through 59.
-- Existing development records reviewed on 2026-11-02 use grace values 30/35.
do $migration$
begin
  if exists (
    select 1 from public.booking_rule_sets where grace_minutes not between 0 and 59
  ) then
    raise exception 'Existing booking rules contain grace values outside 0 to 59; review them before applying this migration';
  end if;

  alter table public.booking_rule_sets
    drop constraint if exists booking_rule_sets_grace_minutes_check;
  alter table public.booking_rule_sets
    add constraint booking_rule_sets_grace_minutes_check
    check (grace_minutes between 0 and 59);
end;
$migration$;

-- Keep both the current four-argument RPC and the legacy three-argument RPC
-- aligned with the table constraint. The legacy overload remains callable by
-- older clients, so its validation must enforce the same range too.
do $migration$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.owner_save_booking_rules(jsonb,integer,date)'::regprocedure,
    'public.owner_save_booking_rules(jsonb,integer,integer,date)'::regprocedure
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    if position('p_grace_minutes is null or p_grace_minutes not between 0 and 720' in v_definition) = 0
       or position('grace period from 0 to 720 minutes' in v_definition) = 0 then
      raise exception 'Owner booking rules save function changed; review minute range validation';
    end if;
    v_updated := replace(v_definition,
      'p_grace_minutes is null or p_grace_minutes not between 0 and 720',
      'p_grace_minutes is null or p_grace_minutes not between 0 and 59');
    v_updated := replace(v_updated,
      'grace period from 0 to 720 minutes',
      'grace period from 0 to 59 minutes');
    if v_updated = v_definition then
      raise exception 'Could not update owner booking rules minute validation';
    end if;
    execute v_updated;
  end loop;
end;
$migration$;
