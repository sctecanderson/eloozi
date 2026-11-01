-- One snapshot for all open tabs in a visit. SECURITY INVOKER keeps the
-- existing table_tabs/table_tab_items RLS policies in force.
create function public.get_visit_tab_consumptions(
  p_restaurant_id uuid,
  p_table_visit_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tableTabId', tab.id,
        'items', coalesce(consumption.items, '[]'::jsonb),
        'totalInCents', coalesce(consumption.total_in_cents, 0)
      ) order by tab.created_at, tab.id
    ),
    '[]'::jsonb
  )
  from public.table_tabs as tab
  cross join lateral (
    select
      jsonb_agg(to_jsonb(item) order by item.created_at, item.id) as items,
      coalesce(sum(item.line_total_in_cents) filter (where item.status = 'active'), 0) as total_in_cents
    from public.table_tab_items as item
    where item.table_tab_id = tab.id
      and item.table_visit_id = tab.table_visit_id
      and item.restaurant_id = tab.restaurant_id
      and item.restaurant_table_id = tab.restaurant_table_id
  ) as consumption
  where tab.restaurant_id = p_restaurant_id
    and tab.table_visit_id = p_table_visit_id
    and tab.status = 'open';
$$;

revoke all privileges on function public.get_visit_tab_consumptions(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_visit_tab_consumptions(uuid, uuid)
  to authenticated;
