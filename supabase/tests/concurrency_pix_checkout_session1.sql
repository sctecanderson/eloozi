-- Sessão 1: Adquire o lock transacional do restaurante ao reservar/criar a fatura PIX pendente,
-- reivindica atomicamente o gateway emission claim (claim_subscription_invoice_gateway_emission)
-- e mantém a transação aberta por 2 segundos para testar concorrência real.
begin;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with reserved as (
  select
    (res ->> 'reused')::boolean as reused,
    (res -> 'invoice' ->> 'id')::uuid as invoice_id
  from public.acquire_or_create_pending_subscription_invoice(
    '99999999-9999-4999-8999-999999999901'::uuid,
    'pro',
    'monthly',
    'pix',
    14900,
    timezone('utc', now()) + interval '30 minutes',
    null,
    null,
    '88888888-8888-4888-8888-888888888801'::uuid
  ) as res
)
select
  'S1' as session_name,
  reserved.reused,
  reserved.invoice_id,
  (claim_res ->> 'claimed')::boolean as claimed,
  (claim_res ->> 'reason') as claim_reason
from reserved
cross join lateral public.claim_subscription_invoice_gateway_emission(reserved.invoice_id) as claim_res;

-- Segurar lock na linha para comprovar que a Sessão 2 aguarda a Sessão 1
select pg_sleep(2.0);

commit;
