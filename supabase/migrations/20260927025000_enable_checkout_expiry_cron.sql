-- The existing minute-by-minute cron job was inert because its Vault token
-- was never provisioned. Generate it inside Vault; Edge verifies against the
-- encrypted database copy through a service-only RPC, so no token is printed
-- into a deployment log or duplicated in Edge secrets.
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),
  'paymongo_expiry_cron_secret','PayMongo checkout expiry worker authentication')
where not exists(select 1 from vault.secrets where name='paymongo_expiry_cron_secret');

create or replace function public.verify_paymongo_expiry_worker(p_token text)
returns boolean language sql security definer set search_path = '' as $$
  select p_token is not null and length(p_token)=64 and exists(
    select 1 from vault.decrypted_secrets v
    where v.name='paymongo_expiry_cron_secret'
      and extensions.digest(v.decrypted_secret,'sha256')=extensions.digest(p_token,'sha256')
  )
$$;
revoke all on function public.verify_paymongo_expiry_worker(text) from public,anon,authenticated;
grant execute on function public.verify_paymongo_expiry_worker(text) to service_role;
