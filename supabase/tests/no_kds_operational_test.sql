-- Observational regression: verifies current behavior, including the delivery blocker.
-- PASS here means findings reproduced, not approval of a complete no-KDS workflow.
begin;
create schema nk;
create table nk.assertions(seq bigint generated always as identity,label text);
create function nk.ok(b boolean,label text) returns text language plpgsql as $$ begin
 if b is distinct from true then raise exception 'FAIL: %',label; end if;
 insert into nk.assertions(label) values(label); return 'PASS: '||label; end $$;
create function nk.call(uid uuid,command text,guest boolean default false) returns jsonb language plpgsql as $$
declare res jsonb; begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','is_anonymous',guest)::text,true);
 set local role authenticated;
 execute command into res;
 reset role;
 return res;
exception when others then reset role; raise;
end $$;
create function nk.denied(uid uuid,command text,want text default '42501') returns text language plpgsql as $$
declare got text:='NO_ERROR'; before_rows jsonb; after_rows jsonb; begin
 select jsonb_agg(to_jsonb(i) order by id) into before_rows from public.table_tab_items i;
 begin perform nk.call(uid,command); exception when others then got:=sqlstate; end;
 select jsonb_agg(to_jsonb(i) order by id) into after_rows from public.table_tab_items i;
 return nk.ok(got=want and before_rows is not distinct from after_rows,'negado '||want||'; itens de todos restaurantes inalterados: '||command);
end $$;
create table nk.findings(label text,result text);
insert into auth.users(id,email,is_anonymous) values
 ('a5000000-0000-4000-8000-000000000001','waiter-a@local.test',false),
 ('a5000000-0000-4000-8000-000000000002','waiter-b@local.test',false),
 ('a5000000-0000-4000-8000-000000000003','guest@local.test',true),
 ('a5000000-0000-4000-8000-000000000004','platform@local.test',false);
insert into public.platform_admins(user_id,active) values('a5000000-0000-4000-8000-000000000004',true);
insert into public.restaurants(id,slug,name,subscription_plan,max_tables,subscription_expires_at) values
 ('b5000000-0000-4000-8000-000000000001','nk-a','No KDS A','basic',5,now()+interval '30 days'),
 ('b5000000-0000-4000-8000-000000000002','nk-b','No KDS B','basic',5,now()+interval '30 days');
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000001','waiter',true),
 ('b5000000-0000-4000-8000-000000000002','a5000000-0000-4000-8000-000000000002','waiter',true);
insert into public.restaurant_tables(restaurant_id,table_number) select 'b5000000-0000-4000-8000-000000000001',n from generate_series(1,3)n;
insert into public.restaurant_tables(restaurant_id,table_number) values('b5000000-0000-4000-8000-000000000002',1);
insert into public.menu_categories(id,restaurant_id,catalog_key,name,slug,active) values
 ('c5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','nk-cat','Pratos','pratos',true);
insert into public.menu_products(id,restaurant_id,category_id,catalog_key,slug,name,price_in_cents,available,preparation_station)
select ('d5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'b5000000-0000-4000-8000-000000000001',
 'c5000000-0000-4000-8000-000000000001','nk-'||n,'produto-'||n,'Produto '||n,1000*n,true,
 case n when 1 then 'kitchen' when 2 then 'bar' else 'none' end from generate_series(1,3)n;
do $$ declare
 w uuid:='a5000000-0000-4000-8000-000000000001';
 other_w uuid:='a5000000-0000-4000-8000-000000000002';
 guest uuid:='a5000000-0000-4000-8000-000000000003';
 platform_uid uuid:='a5000000-0000-4000-8000-000000000004';
 rid uuid:='b5000000-0000-4000-8000-000000000001';
 table_id uuid; visit_id uuid; tab_id uuid; item_id uuid; q jsonb; before_item jsonb;
 station_n integer; source text; plan text; state text; items jsonb; v jsonb;
begin
 -- Both sources, all three preparation stations; visits opened by the waiter.
 foreach source in array array['customer','waiter'] loop
  for station_n in 1..3 loop
   select id into table_id from public.restaurant_tables where restaurant_id=rid and table_number=1;
   q:=nk.call(w,format('select to_jsonb(public.open_table_visit(%L,1))','nk-a'));
   visit_id:=(q->>'id')::uuid;
   if source='customer' then
    q:=nk.call(guest,format('select public.create_direct_table_order(%L,%L,1)',table_id,('d5000000-0000-4000-8000-'||lpad(station_n::text,12,'0'))::uuid),true);
    tab_id:=(q->>'tableTabId')::uuid; item_id:=(q->>'itemId')::uuid;
   else
    q:=nk.call(w,format('select to_jsonb(public.create_table_tab(%L,%L,%L,gen_random_uuid()))','nk-a',visit_id,'Waiter tab'));
    tab_id:=(q->>'id')::uuid;
    q:=nk.call(w,format('select to_jsonb(public.add_table_tab_item(%L,%L,%L,1,gen_random_uuid()))','nk-a',tab_id,('d5000000-0000-4000-8000-'||lpad(station_n::text,12,'0'))::uuid));
    item_id:=(q->>'id')::uuid;
   end if;
   select to_jsonb(i) into before_item from public.table_tab_items i where id=item_id;
   perform nk.ok(before_item->>'production_status'=case station_n when 3 then 'delivered' else 'pending' end,'status inicial correto');
   q:=nk.call(w,format('select public.get_table_tab_consumption(%L,%L)',rid,tab_id));
   perform nk.ok(exists(select 1 from jsonb_array_elements(q->'items') i where i->>'id'=item_id::text),'garcom le consumo sem KDS');
   perform nk.denied(w,'select public.get_kds_active_items(''nk-a'')');
   if station_n<>3 then
    perform nk.denied(w,format('select to_jsonb(public.update_tab_item_production_status(%L,%L,%L))','nk-a',item_id,'preparing'));
    perform nk.denied(w,format('select to_jsonb(public.update_tab_item_production_status(%L,%L,%L))','nk-a',item_id,'delivered'));
   end if;
   -- Same direct-write fallback used by TableTabsPanel: no UPDATE privilege.
   perform nk.denied(w,format('update public.table_tab_items set production_status=''delivered'',prep_delivered_at=now() where id=%L returning to_jsonb(table_tab_items)',item_id));
   q:=nk.call(guest,format('select public.request_table_assistance(%L,%L)',table_id,'close_table_request'),true);
   perform nk.ok((q->>'success')::boolean,'cliente pede conta sem KDS');
   if station_n=1 then
    -- Real guest link fixture; exercise the bill RPC used by BillRequestPanel too.
    insert into public.guest_sessions(id,restaurant_id,restaurant_table_id,user_id,table_visit_id,confirmed_by_member_id,confirmed_at,status)
    select gen_random_uuid(),rid,table_id,guest,visit_id,m.id,now(),'active' from public.restaurant_members m where m.restaurant_id=rid and m.user_id=w
    returning id into item_id;
    insert into public.table_tab_guests(guest_session_id,table_tab_id,table_visit_id,restaurant_id,restaurant_table_id,linked_by_member_id)
    select item_id,tab_id,visit_id,rid,table_id,m.id from public.restaurant_members m where m.restaurant_id=rid and m.user_id=w;
    q:=nk.call(guest,format('select public.request_table_tab_bill(%L,%L,false)','nk-a',tab_id),true);
    perform nk.ok(q->>'status'='created','pedido formal de conta com sessao vinculada');
    q:=nk.call(w,format('select to_jsonb(public.attend_table_tab_bill(%L,%L))','nk-a',q#>>'{request,id}'));
    perform nk.ok(q->>'status'='attended','equipe atende conta sem KDS');
    item_id:=(before_item->>'id')::uuid;
   end if;
   perform nk.denied(other_w,format('select to_jsonb(public.close_table_tab(%L,%L,false))','nk-a',tab_id));
   perform nk.denied(w,format('select to_jsonb(public.close_table_visit(%L,%L))','nk-a',visit_id),'22023');
   q:=nk.call(w,format('select to_jsonb(public.close_table_tab(%L,%L,false))','nk-a',tab_id));
   perform nk.ok(q->>'status'='closed' and (q->>'total_in_cents')::integer=station_n*1000,'fecha comanda pelo valor integral sem exigir delivered');
   q:=nk.call(w,format('select to_jsonb(public.close_table_visit(%L,%L))','nk-a',visit_id));
   perform nk.ok(q->>'status'='closed','encerra visita sem KDS');
   perform nk.ok((select to_jsonb(i)=before_item from public.table_tab_items i where id=item_id),'item, status e historico preservados apos fechamento');
   q:=nk.call(w,format('select public.get_table_tab_consumption(%L,%L)',rid,tab_id));
   perform nk.ok(exists(select 1 from jsonb_array_elements(q->'items') i where i->>'id'=item_id::text),'consumo historico legivel');
   q:=nk.call(other_w,format('select public.get_table_tab_consumption(%L,%L)',rid,tab_id));
   perform nk.ok(q is null or q='null'::jsonb,'consumo outro tenant nao exposto');
   insert into nk.findings values(source||' station '||station_n,'PASS criacao/leitura/conta/fechamento/historico/isolation; status inicial='||(before_item->>'production_status'));
  end loop;
 end loop;
 -- Paid-plan downgrade with real pending/preparing/ready items, not fabricated status updates.
 foreach plan in array array['pro','premium'] loop
  perform nk.call(platform_uid,format('select public.update_restaurant_saas_plan(%L,%L)',rid,plan));
  q:=nk.call(w,'select to_jsonb(public.open_table_visit(''nk-a'',2))'); visit_id:=(q->>'id')::uuid;
  q:=nk.call(w,format('select to_jsonb(public.create_table_tab(%L,%L,%L,gen_random_uuid()))','nk-a',visit_id,'Downgrade'));
  tab_id:=(q->>'id')::uuid;
  foreach state in array array['pending','preparing','ready'] loop
   q:=nk.call(w,format('select to_jsonb(public.add_table_tab_item(%L,%L,%L,1,gen_random_uuid()))','nk-a',tab_id,'d5000000-0000-4000-8000-000000000001'));
   item_id:=(q->>'id')::uuid;
   if state in ('preparing','ready') then perform nk.call(w,format('select to_jsonb(public.update_tab_item_production_status(%L,%L,%L))','nk-a',item_id,'preparing')); end if;
   if state='ready' then perform nk.call(w,format('select to_jsonb(public.update_tab_item_production_status(%L,%L,%L))','nk-a',item_id,'ready')); end if;
  end loop;
  q:=nk.call(w,'select public.get_kds_active_items(''nk-a'')');
  perform nk.ok(jsonb_array_length(q)=3,'tres itens visiveis no KDS pago');
  select jsonb_agg(to_jsonb(i) order by id) into items from public.table_tab_items i where table_tab_id=tab_id;
  perform nk.call(platform_uid,format('select public.update_restaurant_saas_plan(%L,''basic'')',rid));
  perform nk.ok(items=(select jsonb_agg(to_jsonb(i) order by id) from public.table_tab_items i where table_tab_id=tab_id),'downgrade nao apaga nem muda itens');
  perform nk.denied(w,'select public.get_kds_active_items(''nk-a'')');
  for v in select value from jsonb_array_elements(items) loop
   perform nk.denied(w,format('select to_jsonb(public.update_tab_item_production_status(%L,%L,%L))','nk-a',v->>'id',case v->>'production_status' when 'pending' then 'preparing' when 'preparing' then 'ready' else 'delivered' end));
  end loop;
  q:=nk.call(w,format('select public.get_table_tab_consumption(%L,%L)',rid,tab_id));
  perform nk.ok(jsonb_array_length(q->'items')=3,'tres itens permanecem visiveis fora KDS');
  q:=nk.call(w,format('select to_jsonb(public.close_table_tab(%L,%L,false))','nk-a',tab_id));
  perform nk.ok(q->>'status'='closed' and (q->>'total_in_cents')::integer=3000,'fecha 3000 centavos com pending/preparing/ready');
  q:=nk.call(w,format('select to_jsonb(public.close_table_visit(%L,%L))','nk-a',visit_id));
  perform nk.ok(q->>'status'='closed','atendimento existente concluido');
  perform nk.ok(items=(select jsonb_agg(to_jsonb(i) order by id) from public.table_tab_items i where table_tab_id=tab_id),'historico de producao nao reescrito');
  insert into nk.findings values(plan||' -> basic','PASS pending/preparing/ready preservados; entrega bloqueada; comanda e visita fecham normalmente');
 end loop;
end $$;
select label,result from nk.findings order by label;
select seq,label from nk.assertions order by seq;
select 'ASSERTIONS VERIFIED: '||count(*) from nk.assertions;
select 'CONCLUSAO SQL: fechamento financeiro permitido, registro de entrega kitchen/bar bloqueado no Basico; nao aprova fluxo completo.';
rollback;
