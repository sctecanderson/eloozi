-- Sessão 2: Tenta simultaneamente criar/reservar fatura PIX para o mesmo restaurante/plano/ciclo/valor.
-- Deve aguardar o lock da Sessão 1 e, ao prosseguir:
-- 1) Reutilizar exatamente a mesma fatura (reused = true)
-- 2) Ao tentar claim_subscription_invoice_gateway_emission, obter claimed = false e reason = 'in_progress',
--    impedindo categoricamente um segundo POST /payments no Asaas.
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
  'S2' as session_name,
  reserved.reused,
  reserved.invoice_id,
  (claim_res ->> 'claimed')::boolean as claimed,
  (claim_res ->> 'reason') as claim_reason
from reserved
cross join lateral public.claim_subscription_invoice_gateway_emission(reserved.invoice_id) as claim_res;

commit;
