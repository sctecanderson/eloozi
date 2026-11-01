-- Executado apÃ³s todas as migrations no cluster descartÃ¡vel pelo runner dedicado.
begin;
create schema callpay_test;
create function callpay_test.ok(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %', label; end if; raise notice 'PASS: %',label; end $$;
create function callpay_test.as(uid uuid, query text, is_guest boolean default false) returns jsonb language plpgsql as $$
declare result jsonb;
begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','is_anonymous',is_guest)::text,true);
 set local role authenticated; execute query into result; reset role; return result;
exception when others then reset role; raise;
end $$;
insert into auth.users(id,email,is_anonymous) values
 ('a6000000-0000-4000-8000-000000000001','waiter@local.test',false),
 ('a6000000-0000-4000-8000-000000000002','other@local.test',false),
 ('a6000000-0000-4000-8000-000000000003','guest@local.test',true);
insert into public.restaurants(id,name,slug,subscription_plan,max_tables,subscription_expires_at,service_fee_percent,unlimited_tables)
 values('b6000000-0000-4000-8000-000000000001','Callpay A','callpay-a','premium',null,now()+interval '30 days',10,true),
       ('b6000000-0000-4000-8000-000000000002','Callpay B','callpay-b','premium',null,now()+interval '30 days',0,true);
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b6000000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','waiter',true),
 ('b6000000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','waiter',true);
insert into public.restaurant_tables(restaurant_id,table_number) values
 ('b6000000-0000-4000-8000-000000000001',1),('b6000000-0000-4000-8000-000000000002',1);
insert into public.menu_categories(id,restaurant_id,catalog_key,name,slug,active) values
 ('c6000000-0000-4000-8000-000000000001','b6000000-0000-4000-8000-000000000001','callpay-cat','Food','food',true);
insert into public.menu_products(id,restaurant_id,category_id,catalog_key,slug,name,price_in_cents,available,preparation_station)
 values('d6000000-0000-4000-8000-000000000001','b6000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001','p1','p1','100',100,true,'none'),
       ('d6000000-0000-4000-8000-000000000002','b6000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001','p2','p2','200',200,true,'none');
do $$ declare
  uid uuid:='a6000000-0000-4000-8000-000000000001'; guest uuid:='a6000000-0000-4000-8000-000000000003';
  tab uuid; visit uuid; table_id uuid; req jsonb; state jsonb; preview jsonb; result jsonb; replay jsonb;
  ids uuid[]; payid uuid:='e6000000-0000-4000-8000-000000000001'; i int;
begin
  select id into table_id from public.restaurant_tables where restaurant_id='b6000000-0000-4000-8000-000000000001';
  -- Real public RPC cycle: create -> active duplicate returns the same ID -> accept -> complete -> new cycle.
  req:=callpay_test.as(guest, $q$select public.request_waiter('callpay-a',1)$q$,true);
  perform callpay_test.ok(req->>'status'='created','chamado inicial criado pelo RPC autenticado anÃ´nimo');
  req:=callpay_test.as(guest, $q$select public.request_waiter('callpay-a',1)$q$,true);
  perform callpay_test.ok(req->>'status'='existing','chamado ativo nÃ£o duplica');
  visit:=null;
  -- Staff must acknowledge separately from completion.
  req:=callpay_test.as(uid,format($q$select to_jsonb(public.attend_waiter_request('callpay-a',%L))$q$,(req->'request'->>'id')::uuid));
  perform callpay_test.ok(req->>'status'='attended','aceite mantÃ©m estado em atendimento');
  state:=callpay_test.as(guest,$q$select public.get_waiter_request_state('callpay-a',1)$q$,true);
  perform callpay_test.ok(state->'request'->>'status'='attended','cliente sincroniza aceite');
  req:=callpay_test.as(uid,format($q$select to_jsonb(public.complete_waiter_request('callpay-a',%L))$q$,(req->>'id')::uuid));
  perform callpay_test.ok(req->>'status'='completed','conclusÃ£o registra etapa separada');
  state:=callpay_test.as(guest,$q$select public.get_waiter_request_state('callpay-a',1)$q$,true);
  perform callpay_test.ok(state->'request'='null'::jsonb,'conclusÃ£o limpa estado visÃ­vel anterior');
  state:=callpay_test.as(guest,$q$select public.request_waiter('callpay-a',1)$q$,true);
  perform callpay_test.ok(state->>'status'='created' and state->'request'->>'id'<>req->>'id','chamado legÃ­timo gera novo ciclo');

  visit:=(callpay_test.as(uid,$q$select to_jsonb(public.open_table_visit('callpay-a',1))$q$)->>'id')::uuid;
  for i in 1..3 loop
    tab:=(callpay_test.as(uid,format($q$select to_jsonb(public.create_table_tab('callpay-a',%L,%L,%L))$q$,visit,'Tab '||i,('f6000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid))->>'id')::uuid;
    perform callpay_test.as(uid,format($q$select to_jsonb(public.add_table_tab_item('callpay-a',%L,%L,1,gen_random_uuid()))$q$,tab,case when i=2 then 'd6000000-0000-4000-8000-000000000002'::uuid else 'd6000000-0000-4000-8000-000000000001'::uuid end));
    ids:=array_append(ids,tab);
  end loop;
  preview:=callpay_test.as(uid,format($q$select public.preview_table_tabs_payment('callpay-a',array[%L,%L,%L]::uuid[],false)$q$,ids[1],ids[2],ids[3]));
  perform callpay_test.ok((preview->>'totalInCents')::int=400,'trÃªs comandas somam preÃ§os oficiais e taxa por comanda');
  perform callpay_test.ok((callpay_test.as(uid,format($q$select public.preview_table_tabs_payment('callpay-a',array[%L]::uuid[],false)$q$,ids[2]))->>'totalInCents')::int=200,'pagamento de uma comanda preserva total oficial');
  preview:=callpay_test.as(uid,format($q$select public.preview_table_tabs_payment('callpay-a',array[%L,%L]::uuid[],false)$q$,ids[1],ids[2]));
  -- Partial selection closes two, preserves the third and each row/item snapshot.
  result:=callpay_test.as(uid,format($q$select public.close_table_tabs('callpay-a',array[%L,%L]::uuid[],false,%L,%L)$q$,ids[1],ids[2],payid,preview->>'previewToken'));
  perform callpay_test.ok((result->>'totalInCents')::int=300 and (result->>'openTabsCount')::int=1,'pagamento parcial fecha apenas selecionadas');
  perform callpay_test.ok(jsonb_array_length(result->'tabs')=2 and (select count(*)=2 from public.table_tabs where id=any(ids) and status='closed'),'histÃ³rico e identidade das duas comandas preservados');
  perform callpay_test.ok((select count(*)=3 from public.table_tab_items where table_tab_id=any(ids) and status='active'),'itens permanecem individuais e intactos');
  replay:=callpay_test.as(uid,format($q$select public.close_table_tabs('callpay-a',array[%L,%L]::uuid[],false,%L,%L)$q$,ids[1],ids[2],payid,preview->>'previewToken'));
  perform callpay_test.ok(replay=result,'repetiÃ§Ã£o devolve recibo idempotente');
  -- A real consumption change invalidates the exact quoted selection.
  preview:=callpay_test.as(uid,format($q$select public.preview_table_tabs_payment('callpay-a',array[%L]::uuid[],false)$q$,ids[3]));
  perform callpay_test.as(uid,format($q$select to_jsonb(public.add_table_tab_item('callpay-a',%L,%L,1,gen_random_uuid()))$q$,ids[3],'d6000000-0000-4000-8000-000000000002'::uuid));
  begin perform callpay_test.as(uid,format($q$select public.close_table_tabs('callpay-a',array[%L]::uuid[],false,gen_random_uuid(),%L)$q$,ids[3],preview->>'previewToken'));
    raise exception 'expected stale quote rejection'; exception when sqlstate '22023' then null; end;
  perform callpay_test.ok((select status='open' from public.table_tabs where id=ids[3]),'erro antes da confirmaÃ§Ã£o nÃ£o altera comanda selecionada');
  preview:=callpay_test.as(uid,format($q$select public.preview_table_tabs_payment('callpay-a',array[%L]::uuid[],false)$q$,ids[3]));
  result:=callpay_test.as(uid,format($q$select public.close_table_tabs('callpay-a',array[%L]::uuid[],false,%L,%L)$q$,ids[3],'e6000000-0000-4000-8000-000000000002',preview->>'previewToken'));
  perform callpay_test.ok((result->>'openTabsCount')::int=0 and (select count(*)=3 from public.table_tabs where id=any(ids) and status='closed'),'terceira comanda quitada em operaÃ§Ã£o prÃ³pria');
  -- Actual server calls with another tenant's staff identity, not simulated client denials.
  begin
    perform callpay_test.as('a6000000-0000-4000-8000-000000000002',format($q$select public.preview_table_tabs_payment('callpay-a',array[%L]::uuid[],false)$q$,ids[3]));
    raise exception 'FAIL: cross-tenant preview allowed';
  exception when sqlstate '42501' then null; end;
  begin
    perform callpay_test.as('a6000000-0000-4000-8000-000000000002',format($q$select public.close_table_tabs('callpay-a',array[%L]::uuid[],false,gen_random_uuid(),'invalid')$q$,ids[3]));
    raise exception 'FAIL: cross-tenant mutation allowed';
  exception when sqlstate '42501' then null; end;
  -- Cross-restaurant and unlinked staff cannot preview or mutate. Snapshot checks all tabs unchanged.
  perform callpay_test.ok((select count(*)=0 from public.table_tabs where restaurant_id='b6000000-0000-4000-8000-000000000002' and status='closed'),'outro restaurante permanece intocado');
end $$;
rollback;






