begin;
-- Perfil complementar dos funcionários (nome completo, contato, CPF, foto, cargo).
-- Antes ficava apenas em localStorage do navegador do administrador. Aqui o dado
-- é isolado por restaurante e só é acessível por administradores via RPC.
-- A associação é feita pelo e-mail (normalizado): o mesmo e-mail identifica o convite
-- pendente e, depois da aceitação, a conta autenticada em restaurant_members.
-- Migration incremental: não altera tabelas nem funções existentes.
create table public.staff_profiles (
 id uuid primary key default gen_random_uuid(),
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 email text not null check (email = lower(btrim(email)) and char_length(email) <= 254),
 name text not null check (char_length(btrim(name)) between 1 and 120),
 phone text not null default '' check (char_length(phone) <= 40),
 cpf text not null default '' check (char_length(cpf) <= 20),
 birth_date text not null default '' check (char_length(birth_date) <= 20),
 avatar_url text check (avatar_url is null or (char_length(avatar_url) <= 300000 and avatar_url ~ '^data:image/(jpeg|png|webp);base64,')),
 cargo text not null check (char_length(btrim(cargo)) between 1 and 80),
 permissions text[] not null default '{}' check (cardinality(permissions) <= 30),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (restaurant_id, email)
);
alter table public.staff_profiles enable row level security;
revoke all on public.staff_profiles from public, anon, authenticated;

create function public.get_staff_profiles(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 rid:=public.require_catalog_admin(p_slug);
 return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'email',p.email,'name',p.name,'phone',p.phone,
  'cpf',p.cpf,'birthDate',p.birth_date,'avatarUrl',p.avatar_url,'cargo',p.cargo,'permissions',to_jsonb(p.permissions),
  'active',p.active,'createdAt',p.created_at) order by p.email) from public.staff_profiles p where p.restaurant_id=rid),'[]'::jsonb);
end; $$;

create function public.upsert_staff_profile(p_slug text,p_profile jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; row public.staff_profiles%rowtype; email_value text; perms text[];
begin
 rid:=public.lock_staff_management(p_slug);
 if p_profile is null or jsonb_typeof(p_profile)<>'object' then
  raise exception using errcode='22023',message='Dados do funcionário inválidos.'; end if;
 email_value:=lower(btrim(coalesce(p_profile->>'email','')));
 if email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or char_length(email_value)>254
  or char_length(btrim(coalesce(p_profile->>'name','')))=0 or char_length(btrim(coalesce(p_profile->>'cargo','')))=0 then
  raise exception using errcode='22023',message='Confira nome, e-mail e cargo do funcionário.'; end if;
 if jsonb_typeof(coalesce(p_profile->'permissions','[]'::jsonb))<>'array' then
  raise exception using errcode='22023',message='Permissões inválidas.'; end if;
 select coalesce(array_agg(x),'{}') into perms from jsonb_array_elements_text(coalesce(p_profile->'permissions','[]'::jsonb)) x;
 begin
  insert into public.staff_profiles(restaurant_id,email,name,phone,cpf,birth_date,avatar_url,cargo,permissions,active)
  values(rid,email_value,btrim(p_profile->>'name'),btrim(coalesce(p_profile->>'phone','')),btrim(coalesce(p_profile->>'cpf','')),
   btrim(coalesce(p_profile->>'birthDate','')),nullif(p_profile->>'avatarUrl',''),btrim(p_profile->>'cargo'),perms,
   coalesce((p_profile->>'active')::boolean,true))
  on conflict (restaurant_id,email) do update set name=excluded.name,phone=excluded.phone,cpf=excluded.cpf,
   birth_date=excluded.birth_date,avatar_url=excluded.avatar_url,cargo=excluded.cargo,permissions=excluded.permissions,
   active=excluded.active,updated_at=now()
  returning * into row;
 exception when check_violation then
  raise exception using errcode='22023',message='Dados do funcionário inválidos ou foto muito grande.';
 end;
 return jsonb_build_object('id',row.id,'email',row.email,'name',row.name,'phone',row.phone,'cpf',row.cpf,
  'birthDate',row.birth_date,'avatarUrl',row.avatar_url,'cargo',row.cargo,'permissions',to_jsonb(row.permissions),
  'active',row.active,'createdAt',row.created_at);
end; $$;

create function public.delete_staff_profile(p_slug text,p_email text) returns void
language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 rid:=public.lock_staff_management(p_slug);
 delete from public.staff_profiles where restaurant_id=rid and email=lower(btrim(coalesce(p_email,'')));
end; $$;

revoke all on function public.get_staff_profiles(text),public.upsert_staff_profile(text,jsonb),
 public.delete_staff_profile(text,text) from public,anon,authenticated;
grant execute on function public.get_staff_profiles(text),public.upsert_staff_profile(text,jsonb),
 public.delete_staff_profile(text,text) to authenticated;
notify pgrst,'reload schema';
commit;
