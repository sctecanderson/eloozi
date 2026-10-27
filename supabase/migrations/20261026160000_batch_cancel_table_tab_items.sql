-- Migração incremental para cancelamento transacional em lote de itens de consumo de comandas.
-- Permite que múltiplos itens (ex.: botão "Limpar" ou cancelamento em lote) sejam cancelados
-- atomicamente em uma única transação, com garantia de integridade, autorização e persistência do motivo.
-- Identifica de forma clara e idempotente os itens recém-cancelados vs itens já cancelados (already_cancelled).

drop function if exists public.cancel_table_tab_items_batch(text, uuid[], text);

create or replace function public.cancel_table_tab_items_batch(
  p_restaurant_slug text,
  p_item_ids uuid[],
  p_reason text
)
returns table (
  id uuid,
  restaurant_id uuid,
  restaurant_table_id uuid,
  table_visit_id uuid,
  table_tab_id uuid,
  product_id uuid,
  product_name text,
  unit_price_in_cents integer,
  quantity integer,
  line_total_in_cents bigint,
  status text,
  added_by_member_id uuid,
  created_at timestamptz,
  cancelled_by_member_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  already_cancelled boolean
) language plpgsql security definer set search_path = '' as $$
declare
  normalized_reason text;
  distinct_item_ids uuid[];
  v_item_id uuid;
  target_visit_id uuid;
  target_tab_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_item public.table_tab_items%rowtype;
  v_cancelling_member_id uuid;
begin
  normalized_reason := btrim(p_reason);
  if p_item_ids is null or coalesce(cardinality(p_item_ids), 0) = 0 then
    raise exception using errcode = '22023', message = 'Nenhum item informado para cancelamento.';
  end if;

  if normalized_reason is null or char_length(normalized_reason) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'Informe um motivo entre 3 e 300 caracteres.';
  end if;

  -- Remove duplicatas do array de itens recebido
  select array_agg(distinct item_id) into distinct_item_ids
  from unnest(p_item_ids) as item_id;

  -- Itera e valida cada item no lote de forma estrita
  foreach v_item_id in array distinct_item_ids
  loop
    select item.table_visit_id, item.table_tab_id into target_visit_id, target_tab_id
    from public.table_tab_items as item
    join public.restaurants as restaurant on restaurant.id = item.restaurant_id
    where item.id = v_item_id and restaurant.slug = p_restaurant_slug and restaurant.active;

    if not found then
      raise exception using errcode = '22023', message = 'Lançamento não encontrado neste restaurante.';
    end if;

    target_visit := public.lock_owned_table_visit(p_restaurant_slug, target_visit_id);

    select tab.* into target_tab from public.table_tabs as tab
    where tab.id = target_tab_id and tab.table_visit_id = target_visit.id
      and tab.restaurant_id = target_visit.restaurant_id
      and tab.restaurant_table_id = target_visit.restaurant_table_id for update;

    if not found then
      raise exception using errcode = '22023', message = 'Comanda não encontrada neste atendimento.';
    end if;

    select item.* into target_item from public.table_tab_items as item
    where item.id = v_item_id and item.table_tab_id = target_tab.id
      and item.restaurant_id = target_visit.restaurant_id for update;

    if not found then
      raise exception using errcode = '22023', message = 'Lançamento não encontrado.';
    end if;

    -- Se já estiver cancelado, apenas retorna o item existente sem duplicação e identifica que já estava cancelado
    if target_item.status = 'cancelled' then
      return query
      select
        target_item.id,
        target_item.restaurant_id,
        target_item.restaurant_table_id,
        target_item.table_visit_id,
        target_item.table_tab_id,
        target_item.product_id,
        target_item.product_name,
        target_item.unit_price_in_cents,
        target_item.quantity,
        target_item.line_total_in_cents,
        target_item.status,
        target_item.added_by_member_id,
        target_item.created_at,
        target_item.cancelled_by_member_id,
        target_item.cancelled_at,
        target_item.cancellation_reason,
        true as already_cancelled;
      continue;
    end if;

    if target_visit.status <> 'open' or target_tab.status <> 'open' then
      raise exception using errcode = '22023', message = 'Não é possível cancelar consumo em uma comanda encerrada.';
    end if;

    v_cancelling_member_id := coalesce(
      target_visit.assigned_member_id,
      (select member.id from public.restaurant_members member
       where member.restaurant_id = target_visit.restaurant_id
         and member.user_id = auth.uid()
         and member.active limit 1)
    );

    return query
    update public.table_tab_items as t set
      status = 'cancelled',
      cancelled_by_member_id = v_cancelling_member_id,
      cancelled_at = greatest(clock_timestamp(), target_item.created_at),
      cancellation_reason = normalized_reason
    where t.id = target_item.id
    returning
      t.id,
      t.restaurant_id,
      t.restaurant_table_id,
      t.table_visit_id,
      t.table_tab_id,
      t.product_id,
      t.product_name,
      t.unit_price_in_cents,
      t.quantity,
      t.line_total_in_cents,
      t.status,
      t.added_by_member_id,
      t.created_at,
      t.cancelled_by_member_id,
      t.cancelled_at,
      t.cancellation_reason,
      false as already_cancelled;
  end loop;

  return;
end;
$$;

revoke all privileges on function public.cancel_table_tab_items_batch(text, uuid[], text) from public, anon, authenticated;
grant execute on function public.cancel_table_tab_items_batch(text, uuid[], text) to authenticated;
