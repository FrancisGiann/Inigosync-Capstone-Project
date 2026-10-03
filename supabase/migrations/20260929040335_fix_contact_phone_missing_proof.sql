create or replace function internal.guard_contact_phone_validation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_stored text; v_proof boolean:=false;
begin
  if tg_op='UPDATE' and new.contact_num is not distinct from old.contact_num then
    new.phone_verified:=old.phone_verified;
    delete from internal.contact_phone_validation_proofs proof
      where proof.user_id=new.id and proof.phone_e164=internal.ph_mobile_to_e164(new.contact_num)
        and proof.expires_at>now()
      returning true into v_proof;
    if v_proof then
      new.contact_num_validated:=true;
      new.contact_num_validated_at:=now();
    else
      new.contact_num_validated:=old.contact_num_validated;
      new.contact_num_validated_at:=old.contact_num_validated_at;
    end if;
    return new;
  end if;
  if nullif(btrim(new.contact_num),'') is null then
    new.contact_num:=null;
    new.contact_num_validated:=false;
    new.contact_num_validated_at:=null;
    new.phone_verified:=false;
    return new;
  end if;
  v_stored:=internal.ph_mobile_to_e164(new.contact_num);
  if v_stored is null then
    raise exception 'Enter a valid Philippine mobile number' using errcode='22023';
  end if;
  delete from internal.contact_phone_validation_proofs proof
    where proof.user_id=new.id and proof.phone_e164=v_stored and proof.expires_at>now()
    returning true into v_proof;
  if v_proof is distinct from true then
    raise exception 'Validate this Philippine mobile number before saving it' using errcode='42501';
  end if;
  new.contact_num:=v_stored;
  new.contact_num_validated:=true;
  new.contact_num_validated_at:=now();
  new.phone_verified:=false;
  return new;
end;
$$;
