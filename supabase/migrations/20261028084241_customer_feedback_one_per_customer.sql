-- Keep one editable feedback response per customer account. If older installs
-- accumulated multiple rows, preserve the newest response for each customer.
with ranked_feedback as (
    select id,
           row_number() over (
               partition by profile_id
               order by created_at desc, id desc
           ) as row_number
    from public.feedback
)
delete from public.feedback as feedback
using ranked_feedback
where feedback.id = ranked_feedback.id
  and ranked_feedback.row_number > 1;

create unique index if not exists feedback_one_per_profile_idx
    on public.feedback (profile_id);

-- Legacy rows with no rating remain readable and can be repaired in the edit
-- form. NOT VALID avoids fabricating a rating while enforcing it for every
-- subsequent insert or update, including edits to legacy rows.
alter table public.feedback
    drop constraint if exists feedback_rating_check;
alter table public.feedback
    add constraint feedback_rating_required_check
    check (rating is not null and rating between 1 and 5) not valid;

alter table public.feedback
    alter column message drop not null;
alter table public.feedback
    drop constraint if exists feedback_message_check;
alter table public.feedback
    add constraint feedback_message_optional_check
    check (message is null or length(trim(message)) > 0);

revoke all on public.feedback from public, anon;
grant select, insert, update on public.feedback to authenticated;

drop policy if exists feedback_customer_update_own on public.feedback;
create policy feedback_customer_update_own on public.feedback
    for update
    to authenticated
    using (
        profile_id = (select auth.uid())
        and internal.is_active_customer((select auth.uid()))
    )
    with check (
        profile_id = (select auth.uid())
        and internal.is_active_customer((select auth.uid()))
    );
