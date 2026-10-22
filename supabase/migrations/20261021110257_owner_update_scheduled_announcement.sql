-- Only an active owner can edit an announcement, and only while its current
-- publish time is still in the future. The state check is part of the UPDATE
-- predicate so it remains atomic if publication time passes during a request.
create or replace function public.owner_update_scheduled_announcement(
  p_id uuid,
  p_title text,
  p_body text,
  p_audience text,
  p_publish_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare updated_id uuid;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.status = 'active'
  ) then
    raise exception 'Active owner access is required' using errcode = '42501';
  end if;

  if p_id is null
      or p_audience is null
      or p_audience not in ('staff', 'customers', 'both')
      or length(btrim(coalesce(p_title, ''))) not between 1 and 120
      or length(btrim(coalesce(p_body, ''))) not between 1 and 4000
      or p_publish_at is null
      or not isfinite(p_publish_at)
      or p_publish_at <= pg_catalog.clock_timestamp() then
    raise exception 'Invalid scheduled announcement' using errcode = '22023';
  end if;

  update internal.app_announcements a
  set title = btrim(p_title),
      body = btrim(p_body),
      audience = p_audience,
      publish_at = p_publish_at
  where a.id = p_id and a.publish_at > pg_catalog.clock_timestamp()
  returning a.id into updated_id;

  if updated_id is null then
    raise exception 'Announcement is no longer scheduled or does not exist' using errcode = 'P0002';
  end if;

  return jsonb_build_object('id', updated_id, 'status', 'scheduled');
end;
$$;
revoke all on function public.owner_update_scheduled_announcement(uuid, text, text, text, timestamptz) from public, anon;
grant execute on function public.owner_update_scheduled_announcement(uuid, text, text, text, timestamptz) to authenticated;
