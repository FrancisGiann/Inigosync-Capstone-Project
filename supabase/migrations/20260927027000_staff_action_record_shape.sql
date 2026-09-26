-- Avoid referencing fields absent from the other reservation table in one CASE expression.
create or replace function internal.audit_staff_reservation_action()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_role text; v_action text; v_id text; v_info jsonb;
begin
  select p.role into v_role from public.profiles p where p.id=v_actor and p.role in ('staff','admin') and p.status='active';
  if v_role is null then return new; end if;
  if tg_table_name='booking' then v_id:=new.booking_id::text;
  else v_id:=new.walkin_id::text; end if;
  v_info:=jsonb_build_object('court',new.courts,'unit',new.court_unit,'starts_at',new.time_date,
    'total',new.amount_total,'paid',new.amount_paid);
  if tg_op='INSERT' then
    v_action:=case when tg_table_name='walk_in_booking' then 'recorded_walk_in' else 'recorded_booking' end;
  elsif new.checked_in_at is distinct from old.checked_in_at and new.checked_in_at is not null then
    v_action:='checked_in';
    v_info:=v_info||jsonb_build_object('cash_collected',greatest(0,new.amount_paid-old.amount_paid));
  elsif new.status is distinct from old.status then
    v_action:='booking_status_changed';
    v_info:=v_info||jsonb_build_object('from',old.status,'to',new.status);
  elsif new.amount_paid is distinct from old.amount_paid then
    v_action:='collected_payment';
    v_info:=v_info||jsonb_build_object('amount',new.amount_paid-old.amount_paid,
      'method',new.balance_payment_method);
  else return new;
  end if;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,v_role,v_action,case when tg_table_name='booking' then 'booking' else 'walkin' end,v_id,v_info);
  return new;
end;
$$;
