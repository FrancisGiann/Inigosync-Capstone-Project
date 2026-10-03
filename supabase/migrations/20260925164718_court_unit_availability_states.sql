-- Give every unit an explicit operational state while preserving the
-- existing is_active column as the booking selector's compatibility flag.
alter table public.court_unit_inventory
    add column if not exists availability_status text not null default 'available';

update public.court_unit_inventory
set availability_status = case when is_active then 'available' else 'archived' end;

alter table public.court_unit_inventory
    drop constraint if exists court_unit_inventory_availability_status_check,
    add constraint court_unit_inventory_availability_status_check
        check (availability_status in ('available', 'maintenance', 'archived')),
    drop constraint if exists court_unit_inventory_status_active_consistency,
    add constraint court_unit_inventory_status_active_consistency
        check (is_active = (availability_status = 'available'));

create or replace function public.sync_court_unit_availability_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        if new.availability_status <> 'available' then
            new.is_active := false;
        else
            new.is_active := true;
        end if;
    elsif new.availability_status is distinct from old.availability_status then
        new.is_active := (new.availability_status = 'available');
    elsif new.is_active is distinct from old.is_active then
        new.availability_status := case when new.is_active then 'available' else 'archived' end;
    end if;
    return new;
end;
$$;

revoke all on function public.sync_court_unit_availability_status() from public, anon, authenticated;

drop trigger if exists court_unit_inventory_sync_availability_status on public.court_unit_inventory;
create trigger court_unit_inventory_sync_availability_status
before insert or update of availability_status, is_active on public.court_unit_inventory
for each row execute function public.sync_court_unit_availability_status();

comment on column public.court_unit_inventory.availability_status is
    'Owner-managed unit state: available, maintenance, or archived. Only available units have is_active=true and can be booked.';
