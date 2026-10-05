-- QA only. Run after 20261005091500_customer_personal_details_validation.sql
-- in a disposable Supabase database. This transaction rolls back all changes.
begin;

create temporary table qa_private_targets on commit drop as
select (select p.id from public.profiles p where p.role='staff' and p.status='active' limit 1) as staff_id,
       (select p.id from public.profiles p where p.role='customer' and p.status='active' limit 1) as customer_id;
select set_config('qa.staff_id',(select staff_id::text from qa_private_targets),true);
select set_config('qa.customer_id',(select customer_id::text from qa_private_targets),true);
select set_config('request.jwt.claim.role','service_role',true);
select public.reserve_contact_phone_validation(current_setting('qa.customer_id')::uuid);
select public.record_contact_phone_validation(current_setting('qa.customer_id')::uuid,'+639171234567');
select set_config('request.jwt.claim.role','authenticated',true);

do $$
begin
  if current_setting('qa.staff_id',true) is null or current_setting('qa.customer_id',true) is null then
    raise exception 'QA needs an active staff profile and active customer profile';
  end if;
  if not exists(select 1 from internal.contact_phone_validation_proofs
     where user_id=current_setting('qa.customer_id')::uuid and phone_e164='+639171234567' and purpose='contact') then
    raise exception 'Legacy contact-purpose phone proof wrapper failed';
  end if;
end;
$$;

-- Staff can still edit their own existing profiles.emergency_contact_number;
-- this field is no longer guarded by the customer-only phone proof trigger.
select set_config('request.jwt.claim.sub',current_setting('qa.staff_id'),true);
set local role authenticated;
do $$
declare visible_count integer;
begin
  select count(*) into visible_count from public.customer_private_details
   where user_id=current_setting('qa.customer_id')::uuid;
  if visible_count <> 0 then raise exception 'Staff can read customer-private details'; end if;
  update public.profiles
     set emergency_contact_number = case when emergency_contact_number='09170000000' then '09170000001' else '09170000000' end
   where id=current_setting('qa.staff_id')::uuid;
  if not found then raise exception 'Staff profile emergency-contact edit was not allowed'; end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub',current_setting('qa.customer_id'),true);
set local role authenticated;
do $$
declare visible_count integer; rejected boolean:=false;
begin
  select count(*) into visible_count from public.customer_private_details
   where user_id=current_setting('qa.customer_id')::uuid;
  if visible_count <> 1 then raise exception 'Customer cannot read their own private details'; end if;
  begin
    update public.customer_private_details set emergency_contact_number='09171234567'
     where user_id=current_setting('qa.customer_id')::uuid;
  exception when insufficient_privilege then rejected:=true;
  end;
  if not rejected then raise exception 'Unvalidated emergency number was accepted'; end if;
end;
$$;

reset role;
-- Distinct keys are required even for the same number in both customer fields.
insert into internal.contact_phone_validation_proofs(user_id,phone_e164,purpose,expires_at)
values
  (current_setting('qa.customer_id')::uuid,'+639171234567','contact',now()+interval '5 minutes'),
  (current_setting('qa.customer_id')::uuid,'+639171234567','emergency',now()+interval '5 minutes')
on conflict(user_id,phone_e164,purpose) do update set expires_at=excluded.expires_at;

select set_config('request.jwt.claim.sub',current_setting('qa.customer_id'),true);
set local role authenticated;
update public.customer_private_details set emergency_contact_number='09171234567'
 where user_id=current_setting('qa.customer_id')::uuid;
reset role;

do $$
begin
  if not exists(select 1 from public.customer_private_details
     where user_id=current_setting('qa.customer_id')::uuid and emergency_contact_number='+639171234567') then
    raise exception 'Emergency number was not normalized and saved';
  end if;
  if not exists(select 1 from internal.contact_phone_validation_proofs
     where user_id=current_setting('qa.customer_id')::uuid and phone_e164='+639171234567' and purpose='contact') then
    raise exception 'Emergency update consumed the separate contact proof';
  end if;
  if exists(select 1 from internal.contact_phone_validation_proofs
     where user_id=current_setting('qa.customer_id')::uuid and phone_e164='+639171234567' and purpose='emergency') then
    raise exception 'Emergency proof was not consumed';
  end if;
end;
$$;

rollback;
