begin;
create schema ct;
create table ct.results(label text);
create function ct.ok(b boolean,label text) returns text language plpgsql as $$ begin if b is distinct from true then raise exception 'FAIL: %',label; end if; insert into ct.results values('PASS: '||label); return 'PASS: '||label; end $$;
insert into auth.users(id,email) values
 ('a6000000-0000-4000-8000-000000000001','admin-a@test.local'),
 ('a6000000-0000-4000-8000-000000000002','admin-b@test.local'),
 ('a6000000-0000-4000-8000-000000000003','waiter@test.local');
insert into public.restaurants(id,name,slug,phone) values
 ('b6000000-0000-4000-8000-000000000001','Contato A','contact-a','5511999999999'),
 ('b6000000-0000-4000-8000-000000000002','Contato B','contact-b','5511888888888');
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b6000000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000001','admin',true),
 ('b6000000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000002','admin',true),
 ('b6000000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-000000000003','waiter',true);
select ct.ok((public.get_public_restaurant('contact-a')->'contactChannels')='null'::jsonb,'registro antigo permanece em modo legado, nao desativa contatos');
do $$ declare cfg jsonb:='{"instagram":{"value":"@elozi","enabled":true},"whatsapp":{"value":"5511999999999","enabled":true},"facebook":{"value":"https://example.test","enabled":true}}'; rev integer; q jsonb; before_a jsonb; before_b jsonb; got text; uid uuid; k text;
base jsonb := '{"name":"Contato A","subtitle":"","description":"","address":"","phone":"5511999999999","opening_hours":"","theme_primary":"#610000","theme_background":"#FFFFFF","theme_text":"#181818","logo":null,"cover":null}'; begin
 select to_jsonb(r) into before_b from public.restaurants r where slug='contact-b';
 select revision into rev from public.restaurants where slug='contact-a';
 perform set_config('request.jwt.claim.sub','a6000000-0000-4000-8000-000000000001',true);
 perform set_config('request.jwt.claims','{"role":"authenticated","is_anonymous":false}',true);
 set local role authenticated;
 q:=public.save_restaurant_identity('contact-a',rev,base||jsonb_build_object('contact_channels',cfg)); reset role;
 perform ct.ok(q->'contactChannels'=cfg,'salva valores e flags na identidade');
 perform ct.ok(public.get_public_restaurant('contact-a')->'contactChannels'=cfg,'recarregar getter publico retorna valores do servidor');
 select revision into rev from public.restaurants where slug='contact-a';
 cfg:=jsonb_set(cfg,'{instagram,enabled}','false');
 set local role authenticated;
 q:=public.save_restaurant_identity('contact-a',rev,base||jsonb_build_object('contact_channels',cfg));reset role;
 perform ct.ok(q#>>'{contactChannels,instagram,value}'='@elozi' and q#>>'{contactChannels,instagram,enabled}'='false','desativa sem perder valor');
 select revision into rev from public.restaurants where slug='contact-a';
 cfg:=jsonb_set(cfg,'{instagram,enabled}','true');
 set local role authenticated;q:=public.save_restaurant_identity('contact-a',rev,base||jsonb_build_object('contact_channels',cfg));reset role;
 perform ct.ok(q#>>'{contactChannels,instagram,value}'='@elozi' and q#>>'{contactChannels,instagram,enabled}'='true','reativa valor persistido');
 select revision into rev from public.restaurants where slug='contact-a';
 set local role authenticated;q:=public.save_restaurant_identity('contact-a',rev,base);reset role;
 perform ct.ok(q->'contactChannels'=cfg,'cliente antigo que omite campo preserva configuracao');
 foreach k in array array['whatsapp','facebook'] loop
  select revision into rev from public.restaurants where slug='contact-a';
  cfg:=jsonb_set(cfg,array[k,'enabled'],'false');
  set local role authenticated;q:=public.save_restaurant_identity('contact-a',rev,base||jsonb_build_object('contact_channels',cfg));reset role;
  perform ct.ok(q->'contactChannels'=cfg,'desativa '||k||' sem perder valor');
  select revision into rev from public.restaurants where slug='contact-a';
  cfg:=jsonb_set(cfg,array[k,'enabled'],'true');
  set local role authenticated;q:=public.save_restaurant_identity('contact-a',rev,base||jsonb_build_object('contact_channels',cfg));reset role;
  perform ct.ok(q->'contactChannels'=cfg,'reativa '||k||' com mesmo valor');
 end loop;
 got:='NO_ERROR';begin set local role authenticated;perform public.save_restaurant_identity('contact-a',rev,base||jsonb_build_object('contact_channels',cfg));exception when others then got:=sqlstate;end;reset role;
 perform ct.ok(got='40001','revisao antiga nao sobrescreve contatos');
 set local role anon;q:=public.get_public_restaurant('contact-a');reset role;
 perform ct.ok(q->'contactChannels'=cfg,'cardapio anonimo recebe configuracao persistida');
 select to_jsonb(r) into before_a from public.restaurants r where slug='contact-a';
 foreach uid in array array['a6000000-0000-4000-8000-000000000002'::uuid,'a6000000-0000-4000-8000-000000000003'::uuid] loop
  select revision into rev from public.restaurants where slug='contact-a';got:='NO_ERROR';
  perform set_config('request.jwt.claim.sub',uid::text,true);
  begin set local role authenticated;perform public.save_restaurant_identity('contact-a',rev,base||jsonb_build_object('contact_channels',cfg));exception when others then got:=sqlstate;end;reset role;
  perform ct.ok(got='42501','outro restaurante/garcom nao altera configuracao');
 end loop;
 perform set_config('request.jwt.claim.sub','a6000000-0000-4000-8000-000000000001',true);
 update public.restaurant_members set active=false where user_id='a6000000-0000-4000-8000-000000000001';got:='NO_ERROR';
 begin set local role authenticated;perform public.save_restaurant_identity('contact-a',rev,base);exception when others then got:=sqlstate;end;reset role;
 perform ct.ok(got='42501','admin inativo negado');
 update public.restaurant_members set active=true where user_id='a6000000-0000-4000-8000-000000000001';
 got:='NO_ERROR';begin set local role anon;perform public.save_restaurant_identity('contact-a',rev,base);exception when others then got:=sqlstate;end;reset role;
 perform ct.ok(got='42501','anon nao salva');
 got:='NO_ERROR';begin set local role authenticated;perform public.save_restaurant_identity('contact-a',rev,base||'{"contact_channels":{"instagram":{"value":"@x","enabled":true},"whatsapp":{"value":"x","enabled":true},"other":{}}}');exception when others then got:=sqlstate;end;reset role;
 perform ct.ok(got='22023','objeto malformado nao salvo');
 perform ct.ok((select to_jsonb(r)=before_a from public.restaurants r where slug='contact-a'),'tentativas negadas preservam todas as colunas de A');
 perform ct.ok((select to_jsonb(r)=before_b from public.restaurants r where slug='contact-b'),'todas as colunas de B inalteradas');
end $$;
select label from ct.results;
select 'PASS: salvar/recarregar/desativar/reativar e autorizacao executados em PostgreSQL real';
rollback;
