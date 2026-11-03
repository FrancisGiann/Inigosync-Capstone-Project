-- Maya and GrabPay are available on the PayMongo sandbox hosted checkout.
-- Default both on to preserve the methods already shown by test-mode checkout;
-- owner changes then control which of those methods new customer checkouts use.
alter table public.app_settings
  add column if not exists maya_enabled boolean not null default true,
  add column if not exists grab_pay_enabled boolean not null default true;

comment on column public.app_settings.maya_enabled is
  'Whether Maya (PayMongo paymaya) is offered in test-mode customer checkout.';
comment on column public.app_settings.grab_pay_enabled is
  'Whether GrabPay is offered in test-mode customer checkout.';
