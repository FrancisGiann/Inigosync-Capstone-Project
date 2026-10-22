-- Search and status filtering happen before pagination so totals describe the
-- complete matching set rather than only the current page.
create or replace function public.owner_search_announcements(
  p_offset integer default 0,
  p_limit integer default 20,
  p_search text default null,
  p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  search_term text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
begin
  if (select auth.uid()) is null or not exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.status = 'active'
  ) then
    raise exception 'Active owner access is required' using errcode = '42501';
  end if;

  if p_offset is null or p_offset < 0 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid page' using errcode = '22023';
  end if;
  if p_search is not null and pg_catalog.length(p_search) > 200 then
    raise exception 'Search text is too long' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('published', 'scheduled') then
    raise exception 'Invalid announcement status' using errcode = '22023';
  end if;

  with filtered as (
    select a.id, a.title, a.body, a.audience, a.publish_at, a.created_at,
      case when a.publish_at <= pg_catalog.now() then 'published' else 'scheduled' end as status
    from internal.app_announcements a
    where (search_term is null
        or pg_catalog.strpos(pg_catalog.lower(a.title), pg_catalog.lower(search_term)) > 0
        or pg_catalog.strpos(pg_catalog.lower(a.body), pg_catalog.lower(search_term)) > 0)
      and (p_status is null
        or (p_status = 'published' and a.publish_at <= pg_catalog.now())
        or (p_status = 'scheduled' and a.publish_at > pg_catalog.now()))
  ), page as (
    select * from filtered
    order by created_at desc, id desc
    offset p_offset
    limit p_limit
  )
  select pg_catalog.jsonb_build_object(
    'total_count', (select pg_catalog.count(*) from filtered),
    'rows', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page) order by page.created_at desc, page.id desc) from page), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.owner_search_announcements(integer, integer, text, text) from public, anon;
grant execute on function public.owner_search_announcements(integer, integer, text, text) to authenticated;
