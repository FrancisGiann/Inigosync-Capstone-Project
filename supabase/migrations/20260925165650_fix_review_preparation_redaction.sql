-- Keep booking validation/name derivation separate from contact redaction.
create or replace function public.prepare_booking_review()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_customer_id uuid;
    v_status text;
    v_total numeric;
    v_paid numeric;
    v_full_name text;
    v_first_name text;
    v_last_initial text;
begin
    if auth.uid() is null then
        raise exception 'Sign in with the booking account to submit a review' using errcode = '42501';
    end if;
    select b.customer_id, b.status, b.amount_total, b.amount_paid, p.full_name
      into v_customer_id, v_status, v_total, v_paid, v_full_name
    from public.booking b
    left join public.profiles p on p.id = b.customer_id
    where b.booking_id = new.booking_id;
    if not found or v_customer_id <> auth.uid() then
        raise exception 'This booking is not available for review' using errcode = '42501';
    end if;
    if v_status <> 'completed' or v_total is null or v_total <= 0 or coalesce(v_paid, 0) < v_total then
        raise exception 'A completed, fully paid booking is required to review' using errcode = '23514';
    end if;
    v_full_name := nullif(btrim(v_full_name), '');
    v_first_name := coalesce(nullif(split_part(v_full_name, ' ', 1), ''), 'Verified customer');
    v_last_initial := left(nullif(split_part(v_full_name, ' ', 2), ''), 1);
    new.customer_id := auth.uid();
    new.display_name := case when v_last_initial is null then v_first_name else v_first_name || ' ' || v_last_initial || '.' end;
    new.comment := nullif(btrim(new.comment), '');
    new.created_at := now();
    return new;
end;
$$;
revoke all on function public.prepare_booking_review() from public, anon, authenticated;
