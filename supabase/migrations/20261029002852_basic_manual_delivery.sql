begin;
-- Explicit manual delivery only; no KDS grant or commercial changes.
create or replace function public.update_tab_item_production_status(
  p_restaurant_slug text,
  p_item_id uuid,
  p_target_status text
)
returns public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_subscription_plan text;
  target_member_id uuid;
  target_member_role text;
  target_table_id uuid;
  target_visit_id uuid;
  target_tab_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_item public.table_tab_items%rowtype;
begin
  current_user_id := auth.uid();
  if current_user_id is null
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe.';
  end if;

  if p_item_id is null or p_target_status is null or btrim(p_target_status) = '' then
    raise exception using
      errcode = '22023',
      message = 'Informe o item e o estado de produção desejado.';
  end if;

  if p_target_status not in ('pending', 'preparing', 'ready', 'delivered') then
    raise exception using
      errcode = '22023',
      message = 'Estado de produção inválido.';
  end if;

  select restaurant.id, restaurant.subscription_plan
  into target_restaurant_id, target_subscription_plan
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  if target_subscription_plan not in ('pro', 'premium') and not (target_subscription_plan = 'basic' and p_target_status = 'delivered') then
    raise exception using
      errcode = '42501',
      message = 'O módulo KDS é exclusivo para planos Profissional e Premium. Faça upgrade para utilizar a esteira de produção.';
  end if;

  select member.id, member.role
  into target_member_id, target_member_role
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if not found and (target_subscription_plan = 'basic' or not public.is_platform_admin()) then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select *
  into target_item
  from public.table_tab_items
  where id = p_item_id;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Item de comanda não encontrado.';
  end if;

  if target_item.restaurant_id <> target_restaurant_id then
    raise exception using
      errcode = '42501',
      message = 'Item pertence a outro restaurante.';
  end if;

  if target_item.status = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'Itens cancelados não podem ter seu estado de produção alterado.';
  end if;

  target_tab_id := target_item.table_tab_id;
  target_visit_id := target_item.table_visit_id;
  target_table_id := target_item.restaurant_table_id;

  -- Canonical lock order: restaurant, member, table, visit, tab, item.
  perform rt.id from public.restaurant_tables rt
  where rt.id=target_table_id and rt.restaurant_id=target_restaurant_id for update;
  if not found then raise exception 'Mesa indisponivel.' using errcode='22023'; end if;

  select *
  into target_visit
  from public.table_visits
  where id = target_visit_id
  for share;

  if not found or target_visit.status <> 'open' or target_visit.restaurant_id <> target_restaurant_id or target_visit.restaurant_table_id <> target_table_id then
    raise exception using
      errcode = '22023',
      message = 'Atendimento da mesa não está mais aberto.';
  end if;

  select *
  into target_tab
  from public.table_tabs
  where id = target_tab_id
  for share;

  if not found or target_tab.status <> 'open' or target_tab.restaurant_id <> target_restaurant_id or target_tab.table_visit_id <> target_visit_id or target_tab.restaurant_table_id <> target_table_id then
    raise exception using
      errcode = '22023',
      message = 'Comanda não está mais aberta.';
  end if;

  select *
  into target_item
  from public.table_tab_items
  where id = p_item_id
  for update;

  -- Recheck after item lock: a concurrent transfer/cancellation cannot redirect delivery.
  if not found or target_item.status <> 'active'
     or target_item.restaurant_id <> target_restaurant_id
     or target_item.restaurant_table_id <> target_table_id
     or target_item.table_visit_id <> target_visit_id or target_item.table_tab_id <> target_tab_id then
    raise exception 'Item nao esta ativo neste atendimento.' using errcode='22023';
  end if;
  if target_subscription_plan = 'basic' and not coalesce((
    target_member_role = 'admin' or target_visit.assigned_member_id = target_member_id
  ), false) then
    raise exception 'Somente o responsavel ou admin ativo pode confirmar entrega.' using errcode='42501';
  end if;

  if target_item.production_status = p_target_status then
    return target_item;
  end if;

  if target_subscription_plan = 'basic' and p_target_status = 'delivered'
     and target_item.production_status in ('pending','preparing','ready') then
    update public.table_tab_items
    set production_status='delivered',
        prep_delivered_at=coalesce(prep_delivered_at,greatest(clock_timestamp(),created_at))
    where id=p_item_id returning * into target_item;
    return target_item;
  end if;

  if target_item.production_status = 'pending' and p_target_status = 'preparing' then
    update public.table_tab_items
    set
      production_status = 'preparing',
      prep_started_at = coalesce(prep_started_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'preparing' and p_target_status = 'ready' then
    update public.table_tab_items
    set
      production_status = 'ready',
      prep_ready_at = coalesce(prep_ready_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'ready' and p_target_status = 'delivered' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_delivered_at = coalesce(prep_delivered_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'pending' and p_target_status = 'delivered' and target_item.preparation_station = 'none' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_delivered_at = coalesce(prep_delivered_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  else
    raise exception using
      errcode = '22023',
      message = format('Transição de produção inválida: de %s para %s.', target_item.production_status, p_target_status);
  end if;

  return target_item;
end;
$$;

revoke all privileges on function public.update_tab_item_production_status(text, uuid, text) from public, anon, authenticated;
grant execute on function public.update_tab_item_production_status(text, uuid, text) to authenticated;
commit;
