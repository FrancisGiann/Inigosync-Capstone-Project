drop policy if exists court_unit_inventory_admin_write on public.court_unit_inventory;
create policy court_unit_inventory_admin_write on public.court_unit_inventory
    for all to authenticated
    using (exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.role = 'admin'
          and p.status <> 'disabled'
    ))
    with check (exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.role = 'admin'
          and p.status <> 'disabled'
    ));

drop policy if exists physical_court_resource_admin_write on public.physical_court_resource;
create policy physical_court_resource_admin_write on public.physical_court_resource
    for all to authenticated
    using (exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.role = 'admin'
          and p.status <> 'disabled'
    ))
    with check (exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.role = 'admin'
          and p.status <> 'disabled'
    ));

drop policy if exists court_unit_resource_map_admin_write on public.court_unit_resource_map;
create policy court_unit_resource_map_admin_write on public.court_unit_resource_map
    for all to authenticated
    using (exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.role = 'admin'
          and p.status <> 'disabled'
    ))
    with check (exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.role = 'admin'
          and p.status <> 'disabled'
    ));
