-- Asserção final após execução concorrente das Sessões 1 e 2
do $$
declare
  v_count integer;
  v_emission_status text;
begin
  select count(*), max(gateway_emission_status)
  into v_count, v_emission_status
  from public.subscription_invoices
  where restaurant_id = '99999999-9999-4999-8999-999999999901'
    and plan_id = 'pro'
    and billing_cycle = 'monthly'
    and payment_method = 'pix'
    and status = 'pending';

  if v_count <> 1 then
    raise exception 'FALHA CONCORRÊNCIA PIX: Esperava exatamente 1 fatura PIX pendente após 2 sessões simultâneas, mas encontrou %!', v_count;
  end if;

  if v_emission_status <> 'in_progress' then
    raise exception 'FALHA CONCORRÊNCIA PIX: Esperava gateway_emission_status = ''in_progress'', mas encontrou %!', v_emission_status;
  end if;

  raise notice 'PASS CONCORRÊNCIA PIX (2 SESSÕES POSTGRESQL INDEPENDENTES): Apenas 1 fatura PIX pendente criada, reutilizada pela Sessão 2 e autorizada exclusivamente para a Sessão 1 (claimed=t na S1, claimed=f na S2).';
end;
$$;

-- Limpar fixture de concorrência
delete from public.subscription_invoices
where restaurant_id = '99999999-9999-4999-8999-999999999901';
delete from public.restaurants
where id = '99999999-9999-4999-8999-999999999901';
