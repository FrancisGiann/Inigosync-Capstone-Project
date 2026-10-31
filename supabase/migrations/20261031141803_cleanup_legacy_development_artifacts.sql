-- Remove only the audited legacy attendance events whose booking targets no
-- longer exist, then remove the one-time internal cleanup snapshot.
-- The audit rows are pinned to the four reviewed UTC timestamps (all before
-- 2026-10-01). The snapshot
-- is dropped without CASCADE so PostgreSQL blocks unexpected dependencies.
-- This migration is repeatable: a zero-row audit cohort and absent snapshot
-- are accepted after the first successful application.

-- Dry-run: list the exact orphan audit rows selected for removal.
-- select a.id, a.action, a.entity_type, a.entity_id, a.created_at
-- from public.audit_log a
-- where a.created_at < timestamptz '2026-10-01 00:00:00+00'
--   and a.created_at in (
--   timestamptz '2026-08-30 18:59:56.299461+00',
--   timestamptz '2026-09-13 08:46:36.937373+00',
--   timestamptz '2026-09-13 09:00:54.455179+00',
--   timestamptz '2026-09-13 14:02:10.1061+00'
-- )
--   and (
--     (a.action = 'booking_timed_in' and (
--       (a.entity_type = 'booking' and not exists (
--         select 1 from public.booking b where b.booking_id::text = a.entity_id
--       )) or (a.entity_type = 'walk_in_booking' and not exists (
--         select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
--       ))
--     )) or
--     (a.action = 'walkin_recorded' and a.entity_type = 'walk_in_booking'
--       and not exists (
--         select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
--       ))
--   );
-- Expected distribution: 1 booking_timed_in/booking,
-- 1 booking_timed_in/walk_in_booking, 2 walkin_recorded/walk_in_booking.
-- select a.action, a.entity_type, count(*) as orphan_rows
-- from public.audit_log a
-- where a.created_at < timestamptz '2026-10-01 00:00:00+00'
--   and a.created_at in (
--          timestamptz '2026-08-30 18:59:56.299461+00',
--          timestamptz '2026-09-13 08:46:36.937373+00',
--          timestamptz '2026-09-13 09:00:54.455179+00',
--          timestamptz '2026-09-13 14:02:10.1061+00')
--   and (
--     (a.action = 'booking_timed_in' and (
--       (a.entity_type = 'booking' and not exists (select 1 from public.booking b where b.booking_id::text = a.entity_id))
--       or (a.entity_type = 'walk_in_booking' and not exists (select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id))))
--     or (a.action = 'walkin_recorded' and a.entity_type = 'walk_in_booking'
--       and not exists (select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id))
--   )
-- group by a.action, a.entity_type order by a.action, a.entity_type;
-- select table_name, count(*) as rows,
--        count(distinct snapshot_id) as snapshots,
--        count(distinct captured_at) as capture_times,
--        min((captured_at at time zone 'UTC')::date) as first_capture_date,
--        max((captured_at at time zone 'UTC')::date) as last_capture_date
-- from internal.owner_reservation_cleanup_snapshot
-- group by table_name order by table_name;
-- Expected snapshot: one snapshot/capture time at 2026-09-26 12:06:26.530372+00, with
-- _metadata=1, public.booking=7, public.court=1, public.sport=1,
-- public.walk_in_booking=2 (12 rows total).

begin;

-- Prevent concurrent audit writes from changing the reviewed candidate set
-- between the precondition and delete.
lock table public.audit_log in share row exclusive mode;

do $cleanup$
declare
  candidate_count bigint;
  candidate_timestamp_count bigint;
  booking_timed_booking_count bigint;
  booking_timed_walkin_count bigint;
  walkin_recorded_count bigint;
  snapshot_count bigint;
  snapshot_id_count bigint;
  snapshot_capture_count bigint;
  snapshot_wrong_date_count bigint;
  snapshot_unexpected_name_count bigint;
  snapshot_metadata_count bigint;
  snapshot_booking_count bigint;
  snapshot_court_count bigint;
  snapshot_sport_count bigint;
  snapshot_walkin_count bigint;
  snapshot_exists boolean;
begin
  select count(*), count(distinct a.created_at),
         count(*) filter (where a.action = 'booking_timed_in' and a.entity_type = 'booking'),
         count(*) filter (where a.action = 'booking_timed_in' and a.entity_type = 'walk_in_booking'),
         count(*) filter (where a.action = 'walkin_recorded' and a.entity_type = 'walk_in_booking')
    into candidate_count, candidate_timestamp_count, booking_timed_booking_count,
         booking_timed_walkin_count, walkin_recorded_count
  from public.audit_log a
  where a.created_at < timestamptz '2026-10-01 00:00:00+00'
    and a.created_at in (
    timestamptz '2026-08-30 18:59:56.299461+00',
    timestamptz '2026-09-13 08:46:36.937373+00',
    timestamptz '2026-09-13 09:00:54.455179+00',
    timestamptz '2026-09-13 14:02:10.1061+00'
  )
    and (
      (a.action = 'booking_timed_in' and (
        (a.entity_type = 'booking' and not exists (
          select 1 from public.booking b where b.booking_id::text = a.entity_id
        )) or (a.entity_type = 'walk_in_booking' and not exists (
          select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
        ))
      )) or
      (a.action = 'walkin_recorded' and a.entity_type = 'walk_in_booking'
        and not exists (
          select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
        ))
    );

  -- Accept only the audited event cohort (or zero for a rerun). This checks
  -- event shape and cutoff as well as total count, without pinning generated IDs.
  if candidate_count = 0 then
    null;
  elsif candidate_count <> 4
     or candidate_timestamp_count <> 4
     or booking_timed_booking_count <> 1
     or booking_timed_walkin_count <> 1
     or walkin_recorded_count <> 2 then
    raise exception 'Legacy orphan audit cohort differs from the reviewed 1/1/2 distribution (found %, %, %, total %)',
      booking_timed_booking_count, booking_timed_walkin_count, walkin_recorded_count, candidate_count;
  end if;

  delete from public.audit_log a
  where a.created_at < timestamptz '2026-10-01 00:00:00+00'
    and a.created_at in (
    timestamptz '2026-08-30 18:59:56.299461+00',
    timestamptz '2026-09-13 08:46:36.937373+00',
    timestamptz '2026-09-13 09:00:54.455179+00',
    timestamptz '2026-09-13 14:02:10.1061+00'
  )
    and (
      (a.action = 'booking_timed_in' and (
        (a.entity_type = 'booking' and not exists (
          select 1 from public.booking b where b.booking_id::text = a.entity_id
        )) or (a.entity_type = 'walk_in_booking' and not exists (
          select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
        ))
      )) or
      (a.action = 'walkin_recorded' and a.entity_type = 'walk_in_booking'
        and not exists (
          select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
        ))
    );

  get diagnostics candidate_count = row_count;
  if candidate_count not in (0, 4) then
    raise exception 'Deleted an unexpected number of legacy orphan audit rows: %', candidate_count;
  end if;

  if exists (
    select 1 from public.audit_log a
    where a.created_at < timestamptz '2026-10-01 00:00:00+00'
      and a.created_at in (
      timestamptz '2026-08-30 18:59:56.299461+00',
      timestamptz '2026-09-13 08:46:36.937373+00',
      timestamptz '2026-09-13 09:00:54.455179+00',
      timestamptz '2026-09-13 14:02:10.1061+00'
    )
      and (
        (a.action = 'booking_timed_in' and (
          (a.entity_type = 'booking' and not exists (
            select 1 from public.booking b where b.booking_id::text = a.entity_id
          )) or (a.entity_type = 'walk_in_booking' and not exists (
            select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
          ))
        )) or
        (a.action = 'walkin_recorded' and a.entity_type = 'walk_in_booking'
          and not exists (
            select 1 from public.walk_in_booking w where w.walkin_id::text = a.entity_id
          ))
      )
  ) then
    raise exception 'Legacy orphan audit rows remain after cleanup';
  end if;

  select exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'internal'
      and c.relname = 'owner_reservation_cleanup_snapshot'
      and c.relkind in ('r', 'p')
  ) into snapshot_exists;

  if snapshot_exists then
    select count(*), count(distinct snapshot_id), count(distinct captured_at),
           count(*) filter (where captured_at <> timestamptz '2026-09-26 12:06:26.530372+00'),
           count(*) filter (where table_name not in (
             '_metadata', 'public.booking', 'public.court', 'public.sport', 'public.walk_in_booking'
           )),
           count(*) filter (where table_name = '_metadata'),
           count(*) filter (where table_name = 'public.booking'),
           count(*) filter (where table_name = 'public.court'),
           count(*) filter (where table_name = 'public.sport'),
           count(*) filter (where table_name = 'public.walk_in_booking')
      into snapshot_count, snapshot_id_count, snapshot_capture_count, snapshot_wrong_date_count,
           snapshot_unexpected_name_count, snapshot_metadata_count, snapshot_booking_count,
           snapshot_court_count, snapshot_sport_count, snapshot_walkin_count
    from internal.owner_reservation_cleanup_snapshot;

    -- Require precisely the reviewed one-snapshot, one-capture-time cohort.
    -- Unexpected table names, dates, or row counts stop before the drop.
    if snapshot_count <> 12
       or snapshot_id_count <> 1
       or snapshot_capture_count <> 1
       or snapshot_wrong_date_count <> 0
       or snapshot_unexpected_name_count <> 0
       or snapshot_metadata_count <> 1
       or snapshot_booking_count <> 7
       or snapshot_court_count <> 1
       or snapshot_sport_count <> 1
       or snapshot_walkin_count <> 2 then
      raise exception 'Cleanup snapshot does not match the reviewed 2026-09-26 cohort (rows %, snapshot IDs %, capture times %, wrong dates %, unexpected names %, table counts metadata/booking/court/sport/walkin = %/%/%/%/%)',
        snapshot_count, snapshot_id_count, snapshot_capture_count, snapshot_wrong_date_count,
        snapshot_unexpected_name_count, snapshot_metadata_count, snapshot_booking_count,
        snapshot_court_count, snapshot_sport_count, snapshot_walkin_count;
    end if;
  end if;
end
$cleanup$;

-- Deliberately no CASCADE. Any newly created view/constraint dependency stops
-- this statement and rolls back the preceding delete with the migration.
drop table if exists internal.owner_reservation_cleanup_snapshot;

commit;
