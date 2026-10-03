create or replace function public.redact_booking_review_contact()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.comment is not null then
        new.comment := regexp_replace(new.comment,
            '[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}', '[email removed]', 'gi');
        new.comment := regexp_replace(new.comment,
            '([+]?63[[:space:].()/-]*|0)9[0-9[:space:].()/-]{7,}[0-9]', '[phone number removed]', 'g');
    end if;
    return new;
end;
$$;
revoke all on function public.redact_booking_review_contact() from public, anon, authenticated;
