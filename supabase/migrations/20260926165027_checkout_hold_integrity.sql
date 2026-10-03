-- Use the same configuration lock as booking and owner mapping writes, so a
-- new checkout sees one stable physical map while it creates all holds.
create or replace function internal.lock_checkout_resource_config()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update internal.reservation_resource_config_lock set version=version+1 where id=true;
  return new;
end;
$$;
revoke all on function internal.lock_checkout_resource_config() from public,anon,authenticated;
create trigger checkout_intent_lock_resource_config before insert on internal.checkout_intents
  for each row execute function internal.lock_checkout_resource_config();

create or replace function internal.guard_checkout_hold_configuration()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_unit uuid; v_court uuid;
begin
  if tg_table_name='court_unit_resource_map' then
    v_unit:=case when tg_op='DELETE' then old.court_unit_id else new.court_unit_id end;
    if exists(select 1 from internal.checkout_intent_items x join internal.checkout_intents i on i.id=x.intent_id
      where x.unit_id=v_unit and i.status in ('creating','ready','review')) then
      raise exception 'This court connection has an active payment checkout' using errcode='55000';
    end if;
  elsif tg_table_name='court_unit_inventory' then
    v_unit:=case when tg_op='DELETE' then old.id else new.id end;
    if (tg_op='DELETE' or new.label is distinct from old.label
      or new.is_active is distinct from old.is_active or new.inventory_verified is distinct from old.inventory_verified)
      and exists(select 1 from internal.checkout_intent_items x join internal.checkout_intents i on i.id=x.intent_id
        where x.unit_id=v_unit and i.status in ('creating','ready','review')) then
      raise exception 'This lane has an active payment checkout' using errcode='55000';
    end if;
  elsif tg_table_name='court' then
    v_court:=case when tg_op='DELETE' then old.id else new.id end;
    if (tg_op='DELETE' or new.name is distinct from old.name or new.is_active is distinct from old.is_active
      or new.status is distinct from old.status)
      and exists(select 1 from internal.checkout_intent_items x join internal.checkout_intents i on i.id=x.intent_id
        where x.listing_id=v_court and i.status in ('creating','ready','review')) then
      raise exception 'This court has an active payment checkout' using errcode='55000';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function internal.guard_checkout_hold_configuration() from public,anon,authenticated;
create trigger checkout_guard_court before update or delete on public.court
  for each row execute function internal.guard_checkout_hold_configuration();
create trigger checkout_guard_unit before update or delete on public.court_unit_inventory
  for each row execute function internal.guard_checkout_hold_configuration();
create trigger checkout_guard_mapping before insert or update or delete on public.court_unit_resource_map
  for each row execute function internal.guard_checkout_hold_configuration();

-- A provider response with a definite creation failure can be released. An
-- ambiguous timeout stays held for review because a session may still exist.
create or replace function public.abort_failed_paymongo_checkout(p_attempt_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_count integer;
begin
  update internal.paymongo_checkout_attempts set status='expired',updated_at=now()
    where id=p_attempt_id and status='creating' and paymongo_session_id is null
    returning intent_id into v_intent;
  get diagnostics v_count=row_count;
  if v_count=1 and v_intent is not null then
    update internal.checkout_intents set status='expired',updated_at=now() where id=v_intent;
    delete from internal.reservation_resource_slots where hold_item_id in
      (select id from internal.checkout_intent_items where intent_id=v_intent);
  end if;
  return v_count=1;
end;
$$;
revoke all on function public.abort_failed_paymongo_checkout(uuid) from public,anon,authenticated;
grant execute on function public.abort_failed_paymongo_checkout(uuid) to service_role;
