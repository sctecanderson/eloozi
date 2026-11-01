begin;
create schema qtest;
create function qtest.ok(b boolean,label text) returns text language plpgsql as $$ begin
 if b is distinct from true then raise exception 'FAIL: %',label; end if; return 'PASS: '||label; end $$;
create function qtest.snapshot() returns jsonb language sql as $$
 select jsonb_build_array(
 (select jsonb_agg(to_jsonb(r) order by id) from public.restaurants r),
 (select jsonb_agg(to_jsonb(t) order by id) from public.restaurant_tables t),
 (select jsonb_agg(to_jsonb(i) order by id) from public.subscription_invoices i),
 (select jsonb_agg(to_jsonb(a) order by id) from public.platform_audit_logs a),
 (select jsonb_agg(to_jsonb(c) order by id) from subscription_quote_private.cycles c),
 (select jsonb_agg(to_jsonb(p) order by invoice_id) from subscription_quote_private.cycle_payments p),
 (select jsonb_agg(to_jsonb(t) order by restaurant_id) from subscription_quote_private.trial_terms t))
$$;
create function qtest.quote(plan text,cycle text,uid uuid default 'a4000000-0000-4000-8000-000000000001') returns jsonb language plpgsql as $$
declare before_rows jsonb; result jsonb; begin
 before_rows:=qtest.snapshot();
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
 set local role authenticated;
 result:=public.quote_subscription_transition('b4000000-0000-4000-8000-000000000001',plan,cycle);
 reset role;
 perform qtest.ok(before_rows=qtest.snapshot(),'cotar nao altera assinatura, mesas, faturas, auditoria ou evidencia');
 return result;
end $$;
insert into auth.users(id,email) values
 ('a4000000-0000-4000-8000-000000000001','quote-admin@test.local'),
 ('a4000000-0000-4000-8000-000000000002','quote-other@test.local'),
 ('a4000000-0000-4000-8000-000000000003','quote-waiter@test.local'),
 ('a4000000-0000-4000-8000-000000000004','quote-inactive@test.local'),
 ('a4000000-0000-4000-8000-000000000005','quote-platform@test.local');
insert into public.restaurants(id,slug,name,max_tables,subscription_plan,subscription_expires_at) values
 ('b4000000-0000-4000-8000-000000000001','quote-a','Quote A',5,'basic',now()+interval '15 days'),
 ('b4000000-0000-4000-8000-000000000002','quote-b','Quote B',5,'basic',now()+interval '15 days');
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','admin',true),
 ('b4000000-0000-4000-8000-000000000002','a4000000-0000-4000-8000-000000000002','admin',true),
 ('b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000003','waiter',true),
 ('b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000004','admin',false);
insert into public.platform_admins(user_id,active) values('a4000000-0000-4000-8000-000000000005',true);
insert into public.restaurant_tables(restaurant_id,table_number) values('b4000000-0000-4000-8000-000000000001',1);
select qtest.ok(qtest.quote('pro','monthly')->>'reason'='missing_reliable_cycle_history','legado sem dados: indisponivel sem desconto');
insert into subscription_quote_private.cycles(id,restaurant_id,plan_id,billing_cycle,starts_at,ends_at,contracted_price_cents) values
 ('c4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','basic','monthly',now()-interval '15 days',now()+interval '15 days',9990);
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,paid_at,external_reference) values
 ('d4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','basic','monthly','pix',9990,'paid',now()-interval '15 days','quote-paid');
insert into subscription_quote_private.cycle_payments values('d4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',9990);
do $$ declare q jsonb; begin
 q:=qtest.quote('basic','monthly');
 perform qtest.ok(q->>'operation'='renewal' and (q->>'amount_to_charge_cents')::bigint=9990 and (q->>'credit_cents')::bigint=0
 and (q->>'effective_at')::timestamptz=now()+interval '15 days' and (q->>'expires_at')::timestamptz=now()+interval '45 days','renovacao integral 30 dias');
 q:=qtest.quote('pro','monthly');
 perform qtest.ok(q->>'operation'='paid_upgrade' and (q->>'credit_cents')::bigint=4995 and (q->>'amount_to_charge_cents')::bigint=4000
 and (q->>'expires_at')::timestamptz=now()+interval '15 days','upgrade mensal meio ciclo preserva vencimento');
end $$;
select qtest.ok(qtest.quote('pro','yearly')->>'reason'='billing_cycle_change_unsupported','mensal para anual bloqueado');
update subscription_quote_private.cycles set billing_cycle='yearly',starts_at=now()-interval '100 days',ends_at=now()+interval '265 days',contracted_price_cents=109890;
update public.restaurants set subscription_expires_at=now()+interval '265 days' where slug='quote-a';
update public.subscription_invoices set billing_cycle='yearly',amount_cents=109890 where external_reference='quote-paid';
update subscription_quote_private.cycle_payments set confirmed_credit_cents=109890;
do $$ declare q jsonb; begin
 q:=qtest.quote('pro','yearly');
 perform qtest.ok((q->>'credit_cents')::bigint=floor(109890::numeric*265/365) and (q->>'amount_to_charge_cents')::bigint=ceil(197890::numeric*265/365)-floor(109890::numeric*265/365)
 and (q->>'expires_at')::timestamptz=now()+interval '265 days','upgrade anual: preco contratado 11x, divisor 365, debito ceil credito floor');
 q:=qtest.quote('basic','yearly');
 perform qtest.ok(q->>'operation'='renewal' and (q->>'amount_to_charge_cents')::bigint=109890,'renovacao anual integral');
end $$;
select qtest.ok(qtest.quote('pro','monthly')->>'reason'='billing_cycle_change_unsupported','anual para mensal bloqueado');
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,paid_at,external_reference)
values('d4000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','basic','yearly','pix',109890,'paid',now(),'quote-unallocated');
select qtest.ok(qtest.quote('pro','yearly')->>'reason'='unallocated_confirmed_payments','credito de pagamento nao alocado nunca somado nem ignorado');
delete from public.subscription_invoices where external_reference='quote-unallocated';
update subscription_quote_private.cycle_payments set confirmed_credit_cents=109889;
select qtest.ok(qtest.quote('pro','yearly')->>'reason'='unconfirmed_or_inconsistent_cycle_payments','credito insuficiente bloqueado');
update subscription_quote_private.cycle_payments set confirmed_credit_cents=109890;
update public.restaurants set subscription_expires_at=now()+interval '700 days' where slug='quote-a';
select qtest.ok(qtest.quote('pro','yearly')->>'reason'='contract_state_mismatch_or_accumulated_periods','saldo acumulado nao vira ciclo normal');
update public.restaurants set subscription_expires_at=now()+interval '265 days' where slug='quote-a';
insert into subscription_quote_private.cycles(restaurant_id,plan_id,billing_cycle,starts_at,ends_at,contracted_price_cents)
values('b4000000-0000-4000-8000-000000000001','basic','yearly',now()+interval '265 days',now()+interval '630 days',109890);
select qtest.ok(qtest.quote('pro','yearly')->>'reason'='multiple_unelapsed_cycles_unsupported','multiplos ciclos antecipados bloqueados');
delete from subscription_quote_private.cycles where id<>'c4000000-0000-4000-8000-000000000001';
update public.subscription_invoices set status='pending' where external_reference='quote-paid';
select qtest.ok(qtest.quote('pro','yearly')->>'reason'='unconfirmed_or_inconsistent_cycle_payments','fatura pendente nao gera credito');
update public.subscription_invoices set status='paid' where external_reference='quote-paid';
update subscription_quote_private.cycles set plan_id='pro';
update public.restaurants set subscription_plan='pro' where slug='quote-a';
select qtest.ok(qtest.quote('basic','yearly')->>'operation'='scheduled_downgrade' and (qtest.quote('basic','yearly')->>'amount_to_charge_cents')::bigint=0
and (qtest.quote('basic','yearly')->>'effective_at')::timestamptz=now()+interval '265 days','downgrade proximo ciclo sem reembolso');
-- Trial original evidenced separately; existing confirmation is intentionally unchanged.
delete from subscription_quote_private.cycle_payments;
delete from subscription_quote_private.cycles;
update public.subscription_invoices set status='pending' where external_reference='quote-paid';
update public.restaurants set subscription_plan='basic',subscription_is_trial=true,subscription_expires_at=now()+interval '5 days' where slug='quote-a';
select qtest.ok(qtest.quote('pro','monthly')->>'available'='false','trial sem origem comprovada bloqueado');
insert into subscription_quote_private.trial_terms values('b4000000-0000-4000-8000-000000000001',now()-interval '2 days',now()+interval '5 days');
do $$ declare q jsonb; begin q:=qtest.quote('pro','monthly');
 perform qtest.ok(q->>'operation'='trial_purchase' and (q->>'amount_to_charge_cents')::bigint=17990 and (q->>'effective_at')::timestamptz=now()+interval '5 days'
 and (q->>'expires_at')::timestamptz=now()+interval '35 days','contratacao integral apos fim original trial'); end $$;
insert into subscription_quote_private.cycles(id,restaurant_id,plan_id,billing_cycle,starts_at,ends_at,contracted_price_cents) values
 ('c4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','basic','monthly',now()+interval '5 days',now()+interval '35 days',9990);
update public.subscription_invoices set billing_cycle='monthly',amount_cents=9990,status='paid' where external_reference='quote-paid';
insert into subscription_quote_private.cycle_payments values('d4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',9990);
update public.restaurants set subscription_is_trial=false,subscription_expires_at=now()+interval '35 days' where slug='quote-a';
do $$ declare q jsonb; begin q:=qtest.quote('pro','monthly');
 perform qtest.ok(q->>'operation'='trial_paid_upgrade' and (q->>'credit_cents')::bigint=9990 and (q->>'amount_to_charge_cents')::bigint=8000
 and (q->>'expires_at')::timestamptz=now()+interval '35 days','credito do MESMO ciclo futuro sem acrescentar ciclo'); end $$;
update subscription_quote_private.trial_terms set original_end=now()+interval '4 days';
insert into subscription_quote_private.cycles(id,restaurant_id,plan_id,billing_cycle,starts_at,ends_at,contracted_price_cents)
values('c4000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','premium','monthly',now()-interval '60 days',now()-interval '30 days',27990);
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,paid_at,external_reference)
values('d4000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','premium','monthly','pix',27990,'paid',now()-interval '60 days','quote-past');
insert into subscription_quote_private.cycle_payments values('d4000000-0000-4000-8000-000000000002','c4000000-0000-4000-8000-000000000002',27990);
update subscription_quote_private.trial_terms set original_end=now()+interval '5 days';
select qtest.ok((qtest.quote('pro','monthly')->>'credit_cents')::bigint=9990,'credito de OUTRO ciclo passado nao e somado');
update subscription_quote_private.trial_terms set original_end=now()+interval '4 days';
select qtest.ok(qtest.quote('pro','monthly')->>'reason'='future_cycle_outside_proven_trial_unsupported','antecipacao fora trial comprovado bloqueada');
-- Real roles and tenant isolation. Each denied call also leaves all state unchanged.
do $$ declare uid uuid; got text; b jsonb; begin
 foreach uid in array array['a4000000-0000-4000-8000-000000000002'::uuid,'a4000000-0000-4000-8000-000000000003'::uuid,'a4000000-0000-4000-8000-000000000004'::uuid] loop
  b:=qtest.snapshot(); got:='NO_ERROR';
  begin perform qtest.quote('pro','monthly',uid); exception when others then got:=sqlstate; end;
  perform qtest.ok(got='42501' and b=qtest.snapshot(),'outro tenant/garcom/admin inativo negado sem efeitos');
 end loop;
end $$;
select qtest.ok(qtest.quote('pro','monthly','a4000000-0000-4000-8000-000000000005')->>'payment_authorized'='false','platform admin pode cotar, nao autoriza pagamento');
set local role anon;
do $$ begin
 begin perform public.quote_subscription_transition('b4000000-0000-4000-8000-000000000001','pro','monthly'); raise exception 'anon permitido';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select qtest.ok(not has_schema_privilege('authenticated','subscription_quote_private','USAGE'),'evidencias privadas inacessiveis ao cliente');
select 'PASS: cotacoes exercitadas; snapshot de todas as chamadas valida ausencia de efeitos';
rollback;
