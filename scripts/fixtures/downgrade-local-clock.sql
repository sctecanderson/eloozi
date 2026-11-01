-- ONLY for the disposable local runner. Not a migration, never deploy.
-- Advances a fixture clock, NEVER writes contract dates or invents paid history.
begin;
do $$begin
 if current_setting('port')<>'55492' or inet_server_addr()<>inet '127.0.0.1' or current_database()<>'postgres' then
  raise exception 'Local disposable fixture only';
 end if;
end$$;
create schema local_validation;
revoke all on schema local_validation from public,anon,authenticated,service_role;
create table local_validation.clock(moment timestamptz not null);
insert into local_validation.clock values(date_trunc('second',clock_timestamp()));
create function local_validation.clock_now() returns timestamptz language sql stable security definer set search_path='' as $$select moment from local_validation.clock$$;
revoke all on all tables in schema local_validation from public,anon,authenticated,service_role;
revoke all on all functions in schema local_validation from public,anon,authenticated,service_role;
-- Rebind time ONLY in this ephemeral database. Original migration/source files stay intact.
do $$declare r record;d text;changed integer:=0;begin
 for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','subscription_quote_private') and p.prokind='f' loop
  d:=pg_get_functiondef(r.oid);
  if d ~ '\m(now|clock_timestamp|statement_timestamp)\(\)' then
   d:=regexp_replace(d,'\m(now|clock_timestamp|statement_timestamp)\(\)','local_validation.clock_now()','g');
   execute d;changed:=changed+1;
  end if;
 end loop;
 if changed<10 then raise exception 'Clock rebinding incomplete';end if;
 for r in select n.nspname,c.relname,a.attname,pg_get_expr(ad.adbin,ad.adrelid) expression
 from pg_attrdef ad join pg_class c on c.oid=ad.adrelid join pg_namespace n on n.oid=c.relnamespace
 join pg_attribute a on a.attrelid=c.oid and a.attnum=ad.adnum
 where n.nspname in ('public','subscription_quote_private') loop
  if r.expression ~ '\m(now|clock_timestamp|statement_timestamp)\(\)' then
   execute format('alter table %I.%I alter column %I set default %s',r.nspname,r.relname,r.attname,regexp_replace(r.expression,'\m(now|clock_timestamp|statement_timestamp)\(\)','local_validation.clock_now()','g'));
  end if;
 end loop;
end$$;
-- Emulate Supabase's service table grants in the minimal local auth/storage bootstrap.
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
-- Existing invoker timestamp triggers need to READ the clock. They cannot change it.
grant usage on schema local_validation to service_role;
grant execute on function local_validation.clock_now() to service_role;
commit;
