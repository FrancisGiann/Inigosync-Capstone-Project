-- Customer-only personal information must stay out of public.profiles because
-- staff can read customer profile rows for account lookup.
alter table public.profiles
  add column if not exists first_name text,
  add column if not exists middle_name text,
  add column if not exists last_name text;

-- Shared profiles retain the contact-number guard only. Customer emergency
-- validation is attached to the private table below.
drop trigger if exists profiles_contact_phone_validation_guard on public.profiles;

create table if not exists public.customer_private_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  birthdate date,
  civil_status text check (civil_status is null or civil_status in
    ('Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say')),
  emergency_contact_name text,
  emergency_contact_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_private_details_birthdate_valid
    check (birthdate is null or (birthdate >= date '1900-01-01' and birthdate <= (current_timestamp at time zone 'Asia/Manila')::date))
);
alter table public.customer_private_details enable row level security;
revoke all on public.customer_private_details from public, anon;
grant select, insert, update on public.customer_private_details to authenticated;

drop policy if exists customer_private_details_customer_select on public.customer_private_details;
create policy customer_private_details_customer_select on public.customer_private_details
  for select to authenticated
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.profiles p where p.id = (select auth.uid())
      and p.role = 'customer' and p.status = 'active'
  ));
drop policy if exists customer_private_details_customer_insert on public.customer_private_details;
create policy customer_private_details_customer_insert on public.customer_private_details
  for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.profiles p where p.id = (select auth.uid())
      and p.role = 'customer' and p.status = 'active'
  ));
drop policy if exists customer_private_details_customer_update on public.customer_private_details;
create policy customer_private_details_customer_update on public.customer_private_details
  for update to authenticated
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.profiles p where p.id = (select auth.uid())
      and p.role = 'customer' and p.status = 'active'
  ))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.profiles p where p.id = (select auth.uid())
      and p.role = 'customer' and p.status = 'active'
  ));
-- Preserve any customer data already entered through older settings builds,
-- normalize known phone values, then remove it from the shared profile row.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='civil_status') then
    execute $copy$
      insert into public.customer_private_details(user_id,birthdate,civil_status,emergency_contact_name,emergency_contact_number)
      select p.id,p.birthdate,p.civil_status,p.emergency_contact_name,
             coalesce(internal.ph_mobile_to_e164(p.emergency_contact_number),nullif(btrim(p.emergency_contact_number),''))
        from public.profiles p where p.role='customer'
      on conflict (user_id) do update set
        birthdate=coalesce(public.customer_private_details.birthdate,excluded.birthdate),
        civil_status=coalesce(public.customer_private_details.civil_status,excluded.civil_status),
        emergency_contact_name=coalesce(public.customer_private_details.emergency_contact_name,excluded.emergency_contact_name),
        emergency_contact_number=coalesce(public.customer_private_details.emergency_contact_number,excluded.emergency_contact_number)
    $copy$;
    execute 'update public.profiles set birthdate=null,civil_status=null,emergency_contact_name=null,emergency_contact_number=null where role=''customer''';
  else
    insert into public.customer_private_details(user_id,birthdate,emergency_contact_name,emergency_contact_number)
    select p.id,p.birthdate,p.emergency_contact_name,
           coalesce(internal.ph_mobile_to_e164(p.emergency_contact_number),nullif(btrim(p.emergency_contact_number),''))
      from public.profiles p where p.role='customer'
    on conflict (user_id) do update set
      birthdate=coalesce(public.customer_private_details.birthdate,excluded.birthdate),
      emergency_contact_name=coalesce(public.customer_private_details.emergency_contact_name,excluded.emergency_contact_name),
      emergency_contact_number=coalesce(public.customer_private_details.emergency_contact_number,excluded.emergency_contact_number);
    update public.profiles set birthdate=null,emergency_contact_name=null,emergency_contact_number=null where role='customer';
  end if;
end;
$$;

create or replace function public.set_customer_private_details_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.set_customer_private_details_updated_at() from public, anon, authenticated;
drop trigger if exists customer_private_details_updated_at on public.customer_private_details;
create trigger customer_private_details_updated_at before update on public.customer_private_details
for each row execute function public.set_customer_private_details_updated_at();

-- Signup/profile creation ensures every customer can save personal fields via
-- the account settings editor, while leaving staff profiles unchanged.
create or replace function internal.ensure_customer_private_details()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'customer' then
    insert into public.customer_private_details(user_id)
    values (new.id) on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function internal.ensure_customer_private_details() from public, anon, authenticated;
drop trigger if exists profiles_ensure_customer_private_details on public.profiles;
create trigger profiles_ensure_customer_private_details
after insert or update of role on public.profiles
for each row execute function internal.ensure_customer_private_details();
insert into public.customer_private_details(user_id)
select p.id from public.profiles p where p.role='customer'
on conflict (user_id) do nothing;

-- Keep name/profile and private-detail saves in one RLS-checked transaction.
create or replace function public.save_customer_personal_details(
  p_full_name text,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_birthdate date,
  p_civil_status text,
  p_emergency_contact_name text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or not exists (
    select 1 from public.profiles p where p.id=v_user_id and p.role='customer' and p.status='active'
  ) then raise exception 'Active customer account required' using errcode='42501'; end if;
  if p_birthdate is not null and (p_birthdate < date '1900-01-01' or p_birthdate > (current_timestamp at time zone 'Asia/Manila')::date) then
    raise exception 'Birthdate is invalid' using errcode='22023';
  end if;
  if p_civil_status is not null and p_civil_status not in ('Single','Married','Separated','Widowed','Prefer not to say') then
    raise exception 'Civil status is invalid' using errcode='22023';
  end if;
  update public.profiles set full_name=p_full_name, first_name=p_first_name,
    middle_name=p_middle_name, last_name=p_last_name where id=v_user_id;
  if not found then raise exception 'Customer profile was not found' using errcode='P0002'; end if;
  insert into public.customer_private_details(user_id,birthdate,civil_status,emergency_contact_name)
  values(v_user_id,p_birthdate,p_civil_status,nullif(btrim(p_emergency_contact_name),''))
  on conflict(user_id) do update set birthdate=excluded.birthdate,
    civil_status=excluded.civil_status,
    emergency_contact_name=excluded.emergency_contact_name;
end;
$$;
revoke all on function public.save_customer_personal_details(text,text,text,text,date,text,text) from public, anon;
grant execute on function public.save_customer_personal_details(text,text,text,text,date,text,text) to authenticated;

-- Purpose is part of the one-use key: a contact proof cannot be stolen by an
-- emergency-number update, even when both fields hold the same phone number.
alter table internal.contact_phone_validation_proofs add column if not exists purpose text not null default 'contact';
alter table internal.contact_phone_validation_proofs drop constraint if exists contact_phone_validation_proofs_pkey;
alter table internal.contact_phone_validation_proofs add constraint contact_phone_validation_proofs_pkey
  primary key (user_id,phone_e164,purpose);
alter table internal.contact_phone_validation_proofs drop constraint if exists contact_phone_validation_proofs_purpose_check;
alter table internal.contact_phone_validation_proofs add constraint contact_phone_validation_proofs_purpose_check
  check (purpose in ('contact','emergency'));
alter table internal.abstract_phone_validation_usage add column if not exists purpose text not null default 'contact';
alter table internal.abstract_phone_validation_usage drop constraint if exists abstract_phone_validation_usage_purpose_check;
alter table internal.abstract_phone_validation_usage add constraint abstract_phone_validation_usage_purpose_check
  check (purpose in ('contact','emergency'));

drop function if exists public.reserve_contact_phone_validation(uuid);
create function public.reserve_contact_phone_validation(p_user_id uuid,p_purpose text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_role text; v_total integer; v_user integer; v_last timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_user_id is null or p_purpose is null or p_purpose not in ('contact','emergency') then
    raise exception 'Invalid phone validation request' using errcode='42501';
  end if;
  select p.role into v_role from public.profiles p where p.id=p_user_id and p.status='active';
  if v_role is null or v_role not in ('staff','customer','admin') then
    raise exception 'Active account required' using errcode='42501';
  end if;
  if p_purpose='emergency' and v_role<>'customer' then
    raise exception 'Emergency contact validation is available to customers only' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132372::bigint);
  delete from internal.abstract_phone_validation_usage u where u.requested_at<now()-interval '30 days';
  select count(*)::integer into v_total from internal.abstract_phone_validation_usage u where u.requested_at>=now()-interval '30 days';
  select count(*)::integer into v_user from internal.abstract_phone_validation_usage u where u.user_id=p_user_id and u.requested_at>=now()-interval '24 hours';
  select max(u.requested_at) into v_last from internal.abstract_phone_validation_usage u where u.requested_at>=now()-interval '30 days';
  if v_total>=80 then raise exception 'Phone validation monthly safety limit reached' using errcode='55000'; end if;
  if v_user>=3 then raise exception 'Phone validation daily rate limit reached' using errcode='55000'; end if;
  if v_last>now()-interval '1 second' then raise exception 'Phone validation request rate limit reached' using errcode='55000'; end if;
  insert into internal.abstract_phone_validation_usage(user_id,purpose) values(p_user_id,p_purpose);
  return true;
end;
$$;
revoke all on function public.reserve_contact_phone_validation(uuid,text) from public, anon, authenticated;
grant execute on function public.reserve_contact_phone_validation(uuid,text) to service_role;

-- Keep old contact-only Edge Function deployments working during the
-- database/function rollout window. These wrappers cannot request emergency
-- proofs and remain service-role-only.
create function public.reserve_contact_phone_validation(p_user_id uuid)
returns boolean language sql security invoker set search_path = '' as $$
  select public.reserve_contact_phone_validation(p_user_id,'contact')
$$;
revoke all on function public.reserve_contact_phone_validation(uuid) from public, anon, authenticated;
grant execute on function public.reserve_contact_phone_validation(uuid) to service_role;

drop function if exists public.record_contact_phone_validation(uuid,text);
create function public.record_contact_phone_validation(p_user_id uuid,p_phone_e164 text,p_purpose text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' or p_user_id is null
     or p_phone_e164 !~ '^\+639[0-9]{9}$' or p_purpose is null or p_purpose not in ('contact','emergency') then
    raise exception 'Invalid phone validation proof' using errcode='42501';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.status='active'
      and p.role in ('staff','customer','admin')
      and (p_purpose<>'emergency' or p.role='customer')) then
    raise exception 'Active account required' using errcode='42501';
  end if;
  delete from internal.contact_phone_validation_proofs proof where proof.expires_at<=now();
  insert into internal.contact_phone_validation_proofs(user_id,phone_e164,purpose,expires_at)
    values(p_user_id,p_phone_e164,p_purpose,now()+interval '5 minutes')
    on conflict(user_id,phone_e164,purpose) do update set expires_at=excluded.expires_at;
  return true;
end;
$$;
revoke all on function public.record_contact_phone_validation(uuid,text,text) from public, anon, authenticated;
grant execute on function public.record_contact_phone_validation(uuid,text,text) to service_role;

create function public.record_contact_phone_validation(p_user_id uuid,p_phone_e164 text)
returns boolean language sql security invoker set search_path = '' as $$
  select public.record_contact_phone_validation(p_user_id,p_phone_e164,'contact')
$$;
revoke all on function public.record_contact_phone_validation(uuid,text) from public, anon, authenticated;
grant execute on function public.record_contact_phone_validation(uuid,text) to service_role;

-- Restore the existing profiles-only contact-number guard. Emergency contact
-- changes are guarded on the private customer table below, never on profiles
-- where staff invites and owner edits depend on the existing schema.
create or replace function internal.guard_contact_phone_validation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_stored text; v_proof boolean:=false;
begin
  if tg_op='UPDATE' and new.contact_num is not distinct from old.contact_num then
    new.phone_verified:=old.phone_verified;
    delete from internal.contact_phone_validation_proofs proof
      where proof.user_id=new.id and proof.phone_e164=internal.ph_mobile_to_e164(new.contact_num)
        and proof.purpose='contact' and proof.expires_at>now()
      returning true into v_proof;
    if v_proof then
      new.contact_num_validated:=true;
      new.contact_num_validated_at:=now();
    else
      new.contact_num_validated:=old.contact_num_validated;
      new.contact_num_validated_at:=old.contact_num_validated_at;
    end if;
    return new;
  end if;
  if nullif(btrim(new.contact_num),'') is null then
    new.contact_num:=null; new.contact_num_validated:=false;
    new.contact_num_validated_at:=null; new.phone_verified:=false;
    return new;
  end if;
  v_stored:=internal.ph_mobile_to_e164(new.contact_num);
  if v_stored is null then raise exception 'Enter a valid Philippine mobile number' using errcode='22023'; end if;
  delete from internal.contact_phone_validation_proofs proof
    where proof.user_id=new.id and proof.phone_e164=v_stored
      and proof.purpose='contact' and proof.expires_at>now()
    returning true into v_proof;
  if v_proof is distinct from true then raise exception 'Validate this Philippine mobile number before saving it' using errcode='42501'; end if;
  new.contact_num:=v_stored; new.contact_num_validated:=true;
  new.contact_num_validated_at:=now(); new.phone_verified:=false;
  return new;
end;
$$;
revoke all on function internal.guard_contact_phone_validation() from public, anon, authenticated;
drop trigger if exists profiles_contact_phone_validation_guard on public.profiles;
create trigger profiles_contact_phone_validation_guard
before insert or update of contact_num,phone_verified,contact_num_validated,contact_num_validated_at on public.profiles
for each row execute function internal.guard_contact_phone_validation();

create or replace function internal.guard_customer_private_emergency_phone()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_stored text; v_proof boolean:=false;
begin
  if tg_op='UPDATE' and new.emergency_contact_number is not distinct from old.emergency_contact_number then return new; end if;
  if nullif(btrim(new.emergency_contact_number),'') is null then new.emergency_contact_number:=null; return new; end if;
  v_stored:=internal.ph_mobile_to_e164(new.emergency_contact_number);
  if v_stored is null then raise exception 'Enter a valid Philippine emergency contact mobile number' using errcode='22023'; end if;
  delete from internal.contact_phone_validation_proofs proof
   where proof.user_id=new.user_id and proof.phone_e164=v_stored
     and proof.purpose='emergency' and proof.expires_at>now()
  returning true into v_proof;
  if v_proof is distinct from true then raise exception 'Validate the emergency contact mobile number before saving it' using errcode='42501'; end if;
  new.emergency_contact_number:=v_stored;
  return new;
end;
$$;
revoke all on function internal.guard_customer_private_emergency_phone() from public, anon, authenticated;
drop trigger if exists customer_private_emergency_phone_guard on public.customer_private_details;
create trigger customer_private_emergency_phone_guard
before insert or update of emergency_contact_number on public.customer_private_details
for each row execute function internal.guard_customer_private_emergency_phone();
