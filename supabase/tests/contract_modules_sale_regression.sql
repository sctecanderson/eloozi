-- Requires committed basic_manual_delivery_test.sql fixtures; disposable DB only.
begin;
select set_config('request.jwt.claim.sub','a5000000-0000-4000-8000-000000000001',true);
update public.restaurants set subscription_plan='premium' where slug='nk-a';
insert into public.inventory_items(id,restaurant_id,name,unit_measure,current_quantity,alert_threshold)
values('c7000000-0000-4000-8000-000000000099','b5000000-0000-4000-8000-000000000001','Linked before downgrade','un',10,1);
update public.menu_products set inventory_item_id='c7000000-0000-4000-8000-000000000099'
where id='d5000000-0000-4000-8000-000000000003';
update public.restaurants set subscription_plan='basic' where slug='nk-a';
select nk.call('a5000000-0000-4000-8000-000000000003',format('select public.create_direct_table_order(%L,''d5000000-0000-4000-8000-000000000003'',1)',(select restaurant_table_id from public.table_tab_items where id=(select item_id from nk.race))),true);
select nk.ok((select current_quantity=9 from public.inventory_items where id='c7000000-0000-4000-8000-000000000099'),'venda apos downgrade continua com baixa interna de estoque pelo servidor');
commit;
