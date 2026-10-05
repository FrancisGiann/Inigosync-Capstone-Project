-- Customer gender is private account information. Keep it with the other
-- customer-only fields in customer_private_details rather than public.profiles,
-- which staff can read for account lookup.
alter table public.customer_private_details
  add column if not exists gender text;

comment on column public.customer_private_details.gender is
  'Optional gender value shown on the customer profile and editable in Account Settings. Customer-only data is protected by customer_private_details RLS.';

-- Preserve any legacy customer values written to the shared staff profile
-- field, then clear them from profiles so staff-facing reads cannot expose
-- customer gender. The legacy column comes from the separately-run
-- database/schema/018_staff_details.sql, so guard it for fresh migration-only
-- installs where that manual schema file was never applied.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'gender'
  ) then
    execute $copy$
      update public.customer_private_details d
      set gender = nullif(btrim(p.gender), '')
      from public.profiles p
      where p.id = d.user_id
        and p.role = 'customer'
        and d.gender is null
        and nullif(btrim(p.gender), '') is not null
    $copy$;
    execute 'update public.profiles set gender = null where role = ''customer'' and gender is not null';
  end if;
end;
$$;

-- The new overload includes gender while retaining the existing RPC signature
-- during rollout for already-open customer pages using the previous client.
create or replace function public.save_customer_personal_details(
  p_full_name text,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_birthdate date,
  p_civil_status text,
  p_emergency_contact_name text,
  p_gender text
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
  insert into public.customer_private_details(user_id,birthdate,gender,civil_status,emergency_contact_name)
  values(v_user_id,p_birthdate,nullif(btrim(p_gender),''),p_civil_status,nullif(btrim(p_emergency_contact_name),''))
  on conflict(user_id) do update set birthdate=excluded.birthdate,
    gender=excluded.gender,
    civil_status=excluded.civil_status,
    emergency_contact_name=excluded.emergency_contact_name;
end;
$$;
revoke all on function public.save_customer_personal_details(text,text,text,text,date,text,text,text) from public, anon;
grant execute on function public.save_customer_personal_details(text,text,text,text,date,text,text,text) to authenticated;
