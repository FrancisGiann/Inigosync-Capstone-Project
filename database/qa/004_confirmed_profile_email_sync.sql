-- QA only: verifies that a customer cannot write an unconfirmed profile
-- email, while a canonical auth.users email change synchronizes its profile.
-- Run after 20261005090000_sync_confirmed_profile_email.sql in a disposable
-- Supabase database. The transaction rolls back the temporary Auth change.
begin;
set local request.jwt.claim.role = 'authenticated';

create temporary table qa_email_change_target on commit drop as
select u.id, u.email as original_email,
       ('qa-unconfirmed-' || replace(u.id::text, '-', '') || '@example.invalid') as candidate_email
  from auth.users u
  join public.profiles p on p.id = u.id
 where p.role = 'customer'
 limit 1;

do $$
declare
  target record;
  rejected boolean := false;
begin
  select * into target from qa_email_change_target;
  if target.id is null then
    raise exception 'QA needs at least one customer Auth/profile pair';
  end if;

  begin
    update public.profiles set email = target.candidate_email where id = target.id;
  exception when insufficient_privilege then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Unconfirmed direct profile email update was not rejected';
  end if;
end;
$$;

update auth.users u
   set email = t.candidate_email,
       email_confirmed_at = now()
  from qa_email_change_target t
 where u.id = t.id;

do $$
declare
  target record;
begin
  select * into target from qa_email_change_target;
  if not exists (
    select 1 from public.profiles p
     where p.id = target.id and p.email = target.candidate_email
  ) then
    raise exception 'Confirmed Auth email did not synchronize to profiles';
  end if;
end;
$$;

rollback;
