-- Require a birthdate when an account becomes staff, but do not reject a
-- supplied birthdate merely because the role changed from customer to staff.
create or replace function internal.validate_staff_profile_details()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  is_new_staff boolean;
  title_changed boolean;
begin
  if tg_op = 'INSERT' then
    is_new_staff := new.role = 'staff';
    title_changed := true;
  else
    is_new_staff := old.role is distinct from 'staff' and new.role = 'staff';
    title_changed := old.position is distinct from new.position;
  end if;

  if new.role = 'staff' and title_changed
     and coalesce(new.position, '') not in ('Secretary', 'Court Attendant') then
    raise exception 'Staff position must be Secretary or Court Attendant' using errcode = '22023';
  end if;
  if new.role = 'staff' and new.birthdate is null
     and (is_new_staff or (tg_op = 'UPDATE' and old.birthdate is distinct from new.birthdate)) then
    raise exception 'A staff birthdate is required' using errcode = '22023';
  end if;
  if new.role = 'staff' and new.birthdate is not null
     and (new.birthdate > (current_timestamp at time zone 'Asia/Manila')::date
          or new.birthdate < date '1900-01-01') then
    raise exception 'Staff birthdate is invalid' using errcode = '22023';
  end if;
  return new;
end;
$$;
