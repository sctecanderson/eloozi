-- Fixtures para o teste de concorrência real de duas sessões PostgreSQL em acquire_or_create_pending_subscription_invoice
begin;

insert into auth.users (id, email)
values ('88888888-8888-4888-8888-888888888801', 'concurrency.admin@eloozi.com')
on conflict (id) do nothing;

insert into public.restaurants (
  id, slug, name, active, subscription_plan, subscription_expires_at, billing_cycle_days, max_tables, monthly_price_cents
) values (
  '99999999-9999-4999-8999-999999999901',
  'rest-concurrency-pix',
  'Restaurante Concorrência PIX',
  true,
  'basic',
  timezone('utc', now()) + interval '10 days',
  30,
  10,
  9900
)
on conflict (id) do nothing;

delete from public.subscription_invoices
where restaurant_id = '99999999-9999-4999-8999-999999999901';

commit;
