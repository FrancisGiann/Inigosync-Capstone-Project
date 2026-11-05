-- Online attempts are metadata only until PayMongo reports a signed paid
-- event. Availability remains open while a customer reviews or pays; the
-- physical-resource exclusion is enforced when settlement creates/extends a
-- real reservation.
do $migration$
declare
  v_definition text;
  v_updated text;
  v_old text;
  v_new text;
begin
  -- Customer carts still recheck current reservations at checkout start and
  -- reject overlaps inside the same cart. They do not insert a resource hold.
  v_definition := pg_catalog.pg_get_functiondef(
    'public.prepare_paid_checkout_cart(uuid,jsonb,text)'::regprocedure);
  v_old := $old$
    insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select v_item_id,m.resource_id,tstzrange(v_start,v_end,'[)')
      from public.court_unit_resource_map m join public.physical_court_resource r on r.id=m.resource_id and r.is_active
      where m.court_unit_id=v_unit.id;
    get diagnostics v_resource_count=row_count;
    if v_resource_count=0 then raise exception 'Court or lane has no available physical connection' using errcode='22023'; end if;
$old$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Customer checkout hold insertion changed; review nonblocking checkout migration';
  end if;
  v_updated := replace(v_definition, v_old, '');
  v_old := $old$
    insert into internal.checkout_intent_items(intent_id,listing_id,unit_id,sports,courts,court_unit,
      starts_at,ends_at,duration_minutes,rate_quantity,rate_unit,total_minor,charge_minor)
$old$;
  v_new := $new$
    if exists (
      select 1 from internal.reservation_resource_slots rs
      join public.court_unit_resource_map m on m.resource_id=rs.resource_id
      where m.court_unit_id=v_unit.id and rs.during && pg_catalog.tstzrange(v_start,v_end,'[)')
        and (rs.booking_id is not null or rs.walkin_id is not null or rs.maintenance_id is not null)
    ) or exists (
      select 1 from internal.checkout_intent_items prior
      join public.court_unit_resource_map prior_map on prior_map.court_unit_id=prior.unit_id
      join public.court_unit_resource_map current_map on current_map.resource_id=prior_map.resource_id
      where prior.intent_id=v_intent and current_map.court_unit_id=v_unit.id
        and pg_catalog.tstzrange(prior.starts_at,prior.ends_at,'[)') && pg_catalog.tstzrange(v_start,v_end,'[)')
    ) then
      raise exception 'This physical court is already reserved during the selected time' using errcode='23P01';
    end if;
    insert into internal.checkout_intent_items(intent_id,listing_id,unit_id,sports,courts,court_unit,
      starts_at,ends_at,duration_minutes,rate_quantity,rate_unit,total_minor,charge_minor)
$new$;
  if position(v_old in v_updated) = 0 then
    raise exception 'Customer checkout item insertion changed; review nonblocking checkout migration';
  end if;
  v_updated := replace(v_updated, v_old, v_new);
  execute v_updated;

  -- Private walk-in staging retains the quoted reservation details, but
  -- creates no row in the public availability exclusion table.
  execute $function$
    create or replace function internal.stage_online_walkin_reservation()
    returns trigger language plpgsql security definer set search_path = '' as $$
    declare v_order internal.staff_walkin_orders%rowtype;
    begin
      if new.walkin_order_id is null then return new; end if;
      select * into v_order from internal.staff_walkin_orders o where o.id=new.walkin_order_id;
      if not found then raise exception 'Walk-in order does not exist' using errcode='23503'; end if;
      if v_order.status='paid' then return new; end if;
      if v_order.status not in ('awaiting_payment','review') then
        raise exception 'Walk-in order is not eligible for reservation rows' using errcode='55000';
      end if;
      if new.status<>'pending' or new.payment_id is not null or new.payment_method is not null then
        raise exception 'Unpaid online walk-in orders cannot create public reservations' using errcode='55000';
      end if;
      -- staff_create_walkin_order holds the shared availability advisory lock
      -- for this trigger call. Check current real occupancy and earlier staged
      -- items in this same order before allowing checkout to be prepared. This
      -- is deliberately read-only: settlement still arbitrates other sessions
      -- with the resource exclusion constraint.
      if exists (
        select 1
          from internal.reservation_resource_slots rs
          join public.court_unit_resource_map current_map
            on current_map.resource_id=rs.resource_id
          join public.physical_court_resource current_resource
            on current_resource.id=current_map.resource_id and current_resource.is_active
         where current_map.court_unit_id=new.court_unit_inventory_id
           and rs.during && pg_catalog.tstzrange(new.time_date,new.end_at,'[)')
           and (rs.booking_id is not null or rs.walkin_id is not null or rs.maintenance_id is not null)
      ) or exists (
        select 1
          from internal.staff_walkin_order_reservations prior
          join public.court_unit_resource_map prior_map
            on prior_map.court_unit_id=prior.court_unit_inventory_id
          join public.court_unit_resource_map current_map
            on current_map.resource_id=prior_map.resource_id
          join public.physical_court_resource current_resource
            on current_resource.id=current_map.resource_id and current_resource.is_active
         where prior.order_id=new.walkin_order_id
           and current_map.court_unit_id=new.court_unit_inventory_id
           and pg_catalog.tstzrange(prior.time_date,prior.end_at,'[)')
             && pg_catalog.tstzrange(new.time_date,new.end_at,'[)')
      ) then
        raise exception 'One of the selected physical courts is already reserved at that time' using errcode='23P01';
      end if;
      insert into internal.staff_walkin_order_reservations(order_id,staff_id,customer_id,sports,courts,
        time_date,end_at,duration_minutes,court_unit,court_listing_id,court_unit_inventory_id,
        rate_quantity,rate_unit_snapshot,customer_name,customer_mobile,amount_total)
      values(new.walkin_order_id,new.staff_id,new.customer_id,new.sports,new.courts,new.time_date,
        new.end_at,new.duration_minutes,new.court_unit,new.court_listing_id,new.court_unit_inventory_id,
        new.rate_quantity,new.rate_unit_snapshot,new.customer_name,new.customer_mobile,new.amount_total);
      if not exists(select 1 from public.court_unit_resource_map m
          join public.physical_court_resource r on r.id=m.resource_id and r.is_active
          where m.court_unit_id=new.court_unit_inventory_id) then
        raise exception 'This walk-in court has no configured physical resource' using errcode='23503';
      end if;
      return null;
    end;
    $$;
    revoke all on function internal.stage_online_walkin_reservation() from public,anon,authenticated;
  $function$;

  -- Extension attempts likewise retain their full quote and attempt record,
  -- but do not block the extension range before successful payment.
  v_definition := pg_catalog.pg_get_functiondef(
    'public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid,timestamptz)'::regprocedure);
  v_old := $old$
  insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select v_item_id,m.resource_id,pg_catalog.tstzrange(r.ends_at,v_new_end,'[)')
    from public.court_unit_resource_map m join public.physical_court_resource pr
      on pr.id=m.resource_id and pr.is_active where m.court_unit_id=r.unit_id;
  get diagnostics v_resource_count=row_count;
  if v_resource_count=0 then raise exception 'Court unit has no active physical slot' using errcode='22023'; end if;
$old$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Extension checkout hold insertion changed; review nonblocking checkout migration';
  end if;
  execute replace(v_definition, v_old, '');

  -- Court mapping rebuilds must include only actual reservations and
  -- maintenance. Pending checkout metadata is deliberately absent from it.
  v_definition := pg_catalog.pg_get_functiondef(
    'internal.refresh_reservation_resource_slots()'::regprocedure);
  v_old := $old$
  insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select x.id,m.resource_id,tstzrange(x.starts_at,x.ends_at,'[)') from internal.checkout_intent_items x
    join internal.checkout_intents i on i.id=x.intent_id and i.status in ('creating','ready','review')
    join public.court_unit_resource_map m on m.court_unit_id=x.unit_id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active;
$old$;
  v_old := btrim(v_old, E'\r\n');
  if position(v_old in v_definition) = 0 then
    raise exception 'Customer cart hold rebuild changed; review nonblocking checkout migration';
  end if;
  v_updated := replace(v_definition, v_old, '');
  v_old := $old$
  delete from internal.reservation_resource_slots where walkin_order_id is not null;
  insert into internal.reservation_resource_slots(walkin_order_id,resource_id,during)
    select s.order_id,m.resource_id,tstzrange(s.time_date,s.end_at,'[)')
      from internal.staff_walkin_order_reservations s
      join internal.staff_walkin_orders o on o.id=s.order_id and o.status in ('awaiting_payment','review')
      join public.court_unit_resource_map m on m.court_unit_id=s.court_unit_inventory_id
      join public.physical_court_resource r on r.id=m.resource_id and r.is_active;
  if exists(select 1 from internal.staff_walkin_order_reservations s
      join internal.staff_walkin_orders o on o.id=s.order_id and o.status in ('awaiting_payment','review')
      where not exists(select 1 from internal.reservation_resource_slots rs
        where rs.walkin_order_id=s.order_id and rs.during=tstzrange(s.time_date,s.end_at,'[)'))) then
    raise exception 'Every active online walk-in order needs a physical resource' using errcode='23503';
  end if;
$old$;
  v_old := btrim(v_old, E'\r\n');
  if position(v_old in v_updated) = 0 then
    raise exception 'Walk-in hold rebuild changed; review nonblocking checkout migration';
  end if;
  v_updated := replace(v_updated, v_old, '');
  v_old := $old$
    or exists(select 1 from internal.staff_walkin_order_reservations s
      join internal.staff_walkin_orders o on o.id=s.order_id and o.status in ('awaiting_payment','review')
      where not exists(select 1 from internal.reservation_resource_slots rs
        where rs.walkin_order_id=s.order_id and rs.during=tstzrange(s.time_date,s.end_at,'[)')))
$old$;
  v_old := btrim(v_old, E'\r\n');
  if position(v_old in v_updated) > 0 then
    v_updated := replace(v_updated, v_old, '');
  end if;
  v_old := $old$
    or exists(select 1 from internal.checkout_intent_items x join internal.checkout_intents i on i.id=x.intent_id and i.status in ('creating','ready','review')
      where not exists(select 1 from internal.reservation_resource_slots r where r.hold_item_id=x.id)) then
$old$;
  v_old := btrim(v_old, E'\r\n');
  if position(v_old in v_updated) = 0 then
    raise exception 'Customer cart hold integrity check changed; review nonblocking checkout migration';
  end if;
  v_updated := replace(v_updated, v_old, ' then');
  execute v_updated;
end;
$migration$;

-- A paid event can arrive after another customer has booked the same slot.
-- The exclusion constraint is the final authority. Roll back only the failed
-- reservation/payment-ledger subtransaction, record the captured payment on
-- its attempt, and leave an auditable owner action instead of retrying forever.
do $migration$
declare
  v_definition text;
  v_updated text;
  v_old text;
  v_new text;
begin
  v_definition := pg_catalog.pg_get_functiondef(
    'public.record_paymongo_paid(text,text,text,bigint,bigint,bigint)'::regprocedure);

  v_old := $old$
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'system'),'checkout_payment_needs_review','paymongo_attempt',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'base_minor',a.amount_minor,
            'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,'net_minor',p_net_minor));
$old$;
  v_new := $new$
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'system'),'checkout_payment_needs_review','paymongo_attempt',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'base_minor',a.amount_minor,
            'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,'net_minor',p_net_minor,
            'refund_review_required',true,
            'resolution','The selected court was booked before payment settled; verify the charge and arrange another time or refund.'));
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Customer payment review audit changed; review collision recovery';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'system'),
          'payment_after_checkout_expiry','paymongo_checkout',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'base_minor',a.amount_minor,
            'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,'net_minor',p_net_minor));
$old$;
  v_new := $new$
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'system'),
          'payment_after_checkout_expiry','paymongo_checkout',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'base_minor',a.amount_minor,
            'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,'net_minor',p_net_minor,
            'refund_review_required',true,
            'resolution','PayMongo reported payment after checkout expiry; verify the charge and arrange an alternate time or refund.'));
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expired checkout payment audit changed; review payment exception recovery';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
    if not exists(select 1 from internal.staff_booking_extension_checkouts e where e.intent_id=a.intent_id and e.status='ready')
       or v_balance_end is distinct from x.starts_at then
      update internal.staff_booking_extension_checkouts set status='review' where intent_id=a.intent_id;
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'review';
    end if;
$old$;
  v_new := $new$
    if not exists(select 1 from internal.staff_booking_extension_checkouts e where e.intent_id=a.intent_id and e.status='ready')
       or v_balance_end is distinct from x.starts_at then
      update internal.staff_booking_extension_checkouts set status='review' where intent_id=a.intent_id;
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        select e.staff_id,coalesce(p.role,'staff'),'paid_extension_reservation_changed','paymongo_checkout',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'booking_source',e.source,
            'reservation_id',e.reservation_id,'original_end_at',e.old_end_at,'extension_end_at',e.new_end_at,
            'amount_minor',a.amount_minor,'refund_review_required',true,
            'resolution','The reservation changed before payment settled; verify the charge and arrange an alternate time or refund.')
        from internal.staff_booking_extension_checkouts e
        left join public.profiles p on p.id=e.staff_id where e.intent_id=a.intent_id;
      return 'review';
    end if;
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Extension reservation-change branch changed; review paid conflict recovery';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
    v_due:=a.amount_minor;
    perform set_config('inigosync.staff_payment_rpc','on',true);
    perform set_config('inigosync.staff_extension_rpc','on',true);
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
      values(v_due/100.0,v_due/100.0,'PayMongo','full',v_due,p_fee_minor,p_amount_minor,p_net_minor)
      returning payment_id into v_payment_id;
    if x.extension_source='booking' then
      delete from internal.reservation_resource_slots where hold_item_id=x.id;
      update public.booking set end_at=x.ends_at,amount_total=coalesce(amount_total,
        internal.authoritative_reservation_amount(court_listing_id,court_unit_inventory_id,time_date,x.starts_at,
          extract(epoch from (x.starts_at-time_date))::integer/60,1))+v_due/100.0,
        amount_paid=amount_paid+v_due/100.0,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now()
        where booking_id=x.extension_reservation_id and end_at=x.starts_at;
      perform internal.persist_payment_acknowledgment(v_payment_id,'booking',x.extension_reservation_id,null);
    else
      delete from internal.reservation_resource_slots where hold_item_id=x.id;
      update public.walk_in_booking set end_at=x.ends_at,amount_total=coalesce(amount_total,
        internal.authoritative_reservation_amount(court_listing_id,court_unit_inventory_id,time_date,x.starts_at,
          extract(epoch from (x.starts_at-time_date))::integer/60,1))+v_due/100.0,
        amount_paid=amount_paid+v_due/100.0,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now()
        where walkin_id=x.extension_reservation_id and end_at=x.starts_at;
      perform internal.persist_payment_acknowledgment(v_payment_id,'walkin',x.extension_reservation_id,null);
    end if;
    update internal.staff_booking_extension_checkouts set status='paid',payment_id=v_payment_id where intent_id=a.intent_id;
    update internal.checkout_intents set status='paid',updated_at=now() where id=a.intent_id;
    update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
    return 'paid';
$old$;
  v_new := $new$
    begin
      v_due:=a.amount_minor;
      perform set_config('inigosync.staff_payment_rpc','on',true);
      perform set_config('inigosync.staff_extension_rpc','on',true);
      insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
        values(v_due/100.0,v_due/100.0,'PayMongo','full',v_due,p_fee_minor,p_amount_minor,p_net_minor)
        returning payment_id into v_payment_id;
      if x.extension_source='booking' then
        update public.booking set end_at=x.ends_at,amount_total=coalesce(amount_total,
          internal.authoritative_reservation_amount(court_listing_id,court_unit_inventory_id,time_date,x.starts_at,
            extract(epoch from (x.starts_at-time_date))::integer/60,1))+v_due/100.0,
          amount_paid=amount_paid+v_due/100.0,balance_payment_id=v_payment_id,
          balance_payment_method='PayMongo',balance_paid_at=now()
          where booking_id=x.extension_reservation_id and end_at=x.starts_at;
        perform internal.persist_payment_acknowledgment(v_payment_id,'booking',x.extension_reservation_id,null);
      else
        update public.walk_in_booking set end_at=x.ends_at,amount_total=coalesce(amount_total,
          internal.authoritative_reservation_amount(court_listing_id,court_unit_inventory_id,time_date,x.starts_at,
            extract(epoch from (x.starts_at-time_date))::integer/60,1))+v_due/100.0,
          amount_paid=amount_paid+v_due/100.0,balance_payment_id=v_payment_id,
          balance_payment_method='PayMongo',balance_paid_at=now()
          where walkin_id=x.extension_reservation_id and end_at=x.starts_at;
        perform internal.persist_payment_acknowledgment(v_payment_id,'walkin',x.extension_reservation_id,null);
      end if;
      update internal.staff_booking_extension_checkouts set status='paid',payment_id=v_payment_id where intent_id=a.intent_id;
      update internal.checkout_intents set status='paid',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'paid';
    exception when exclusion_violation then
      update internal.staff_booking_extension_checkouts set status='review' where intent_id=a.intent_id;
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        select e.staff_id,coalesce(p.role,'staff'),'paid_extension_slot_conflict','paymongo_checkout',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'booking_source',e.source,
            'reservation_id',e.reservation_id,'original_end_at',e.old_end_at,'extension_end_at',e.new_end_at,
            'amount_minor',a.amount_minor,'refund_review_required',true,
            'resolution','The extension slot was booked before payment settled; verify the charge and arrange an alternate time or refund.')
        from internal.staff_booking_extension_checkouts e
        left join public.profiles p on p.id=e.staff_id where e.intent_id=a.intent_id;
      return 'review';
    end;
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Extension settlement block changed; review paid collision recovery';
  end if;
  v_updated := replace(v_definition, v_old, v_new);

  v_old := $old$
    perform set_config('inigosync.staff_payment_rpc','on',true);
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
      values(v_order_total/100.0,a.amount_minor/100.0,'PayMongo','full',a.amount_minor,
        p_fee_minor,p_amount_minor,p_net_minor) returning payment_id into v_payment_id;
    update internal.staff_walkin_orders set status='paid',payment_id=v_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,updated_at=now() where id=v_order.id;
    update public.walk_in_booking w set status='confirmed',payment_method='PayMongo',
      payment_id=v_payment_id,amount_paid=w.amount_total
      where w.walkin_order_id=v_order.id and w.status='pending';
    v_receipt:=internal.persist_payment_acknowledgment(v_payment_id,'walkin_order',null,v_order.id);
    update internal.staff_walkin_orders set receipt_id=(v_receipt->>'receipt_id')::uuid
      where id=v_order.id;
    update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now()
      where id=a.id;
    select p.role into v_role from public.profiles p where p.id=a.staff_id;
    insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
      values(a.staff_id,coalesce(v_role,'staff'),'collected_online_walkin','walkin_order',v_order.id::text,
        jsonb_build_object('payment_id',v_payment_id,'paymongo_payment_id',p_payment_id,
          'base_minor',a.amount_minor,'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,
          'net_minor',p_net_minor,'receipt_id',v_receipt->>'receipt_id'));
    return 'paid';
$old$;
  v_new := $new$
    begin
      perform set_config('inigosync.staff_payment_rpc','on',true);
      insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
        values(v_order_total/100.0,a.amount_minor/100.0,'PayMongo','full',a.amount_minor,
          p_fee_minor,p_amount_minor,p_net_minor) returning payment_id into v_payment_id;
      update internal.staff_walkin_orders set status='paid',payment_id=v_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,updated_at=now() where id=v_order.id;
      update public.walk_in_booking w set status='confirmed',payment_method='PayMongo',
        payment_id=v_payment_id,amount_paid=w.amount_total
        where w.walkin_order_id=v_order.id and w.status='pending';
      v_receipt:=internal.persist_payment_acknowledgment(v_payment_id,'walkin_order',null,v_order.id);
      update internal.staff_walkin_orders set receipt_id=(v_receipt->>'receipt_id')::uuid
        where id=v_order.id;
      update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now()
        where id=a.id;
      select p.role into v_role from public.profiles p where p.id=a.staff_id;
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'staff'),'collected_online_walkin','walkin_order',v_order.id::text,
          jsonb_build_object('payment_id',v_payment_id,'paymongo_payment_id',p_payment_id,
            'base_minor',a.amount_minor,'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,
            'net_minor',p_net_minor,'receipt_id',v_receipt->>'receipt_id'));
      return 'paid';
    exception when exclusion_violation then
      update internal.staff_walkin_orders set status='review',updated_at=now() where id=v_order.id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now()
        where id=a.id;
      select p.role into v_role from public.profiles p where p.id=a.staff_id;
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'staff'),'paid_walkin_slot_conflict','paymongo_checkout',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'walkin_order_id',v_order.id,
            'amount_minor',a.amount_minor,'refund_review_required',true,
            'resolution','The court was booked before payment settled; verify the charge and arrange another time or refund.'));
      return 'review';
    end;
$new$;
  if position(v_old in v_updated) = 0 then
    raise exception 'Walk-in settlement block changed; review paid collision recovery';
  end if;
  v_updated := replace(v_updated, v_old, v_new);
  execute v_updated;
end;
$migration$;

-- Existing provisional rows are obsolete under the new contract. Keep their
-- checkout, attempt, staged quote, and audit records intact; remove only the
-- two occupancy projections. Real booking, walk-in, and maintenance rows are
-- untouched. This also releases any currently open checkout immediately.
delete from internal.reservation_resource_slots
where hold_item_id is not null or walkin_order_id is not null;

do $migration$
begin
  if exists(select 1 from internal.reservation_resource_slots
      where hold_item_id is not null or walkin_order_id is not null) then
    raise exception 'Provisional checkout occupancy remains after migration';
  end if;
end;
$migration$;
