begin;
-- Existing contracts retain their rights explicitly; future inserts opt into v1.
alter table public.restaurants add column contract_rights_model text not null default 'legacy';
alter table public.restaurants alter column contract_rights_model set default 'commercial_v1';
alter table public.restaurants add constraint contract_rights_model_valid check(contract_rights_model in ('legacy','commercial_v1'));
create function public.protect_contract_rights_model() returns trigger language plpgsql set search_path='' as $$ begin
 if TG_OP='UPDATE' and new.contract_rights_model is distinct from old.contract_rights_model then
 raise exception 'Contract rights are immutable; migration requires explicit approval.' using errcode='42501'; end if;
 if TG_OP='INSERT' and new.contract_rights_model <> 'commercial_v1' then raise exception 'New contracts require commercial_v1.' using errcode='42501'; end if;
 return new; end $$;
create trigger protect_contract_rights_model before insert or update on public.restaurants for each row execute function public.protect_contract_rights_model();
revoke all on function public.protect_contract_rights_model() from public,anon,authenticated;
create function public.has_contract_module(p_restaurant_id uuid,p_module text) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select (r.contract_rights_model='legacy' or r.subscription_plan='premium') from public.restaurants r where r.id=p_restaurant_id),false) and p_module in ('inventory','finance') and (public.is_platform_admin() or exists(select 1 from public.restaurant_members m where m.restaurant_id=p_restaurant_id and m.user_id=auth.uid() and m.active));
$$;
revoke all on function public.has_contract_module(uuid,text) from public,anon,authenticated;
grant execute on function public.has_contract_module(uuid,text) to authenticated;
create function public.get_restaurant_module_access(p_restaurant_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.restaurants; member_role text; begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select * into r from public.restaurants where id=p_restaurant_id and active;
 if not found then raise exception 'Restaurant unavailable' using errcode='42501'; end if;
 select role into member_role from public.restaurant_members where restaurant_id=r.id and user_id=auth.uid() and active;
 if member_role is null and not public.is_platform_admin() then raise exception 'Membership required' using errcode='42501'; end if;
 return jsonb_build_object('model',r.contract_rights_model,'inventory',public.has_contract_module(r.id,'inventory') and (member_role is not null or public.is_platform_admin()),'finance',public.has_contract_module(r.id,'finance') and (member_role='admin' or public.is_platform_admin()));
end $$;
revoke all on function public.get_restaurant_module_access(uuid) from public,anon,authenticated;
grant execute on function public.get_restaurant_module_access(uuid) to authenticated;
create policy inventory_alert_contract_gate on public.restaurant_alerts as restrictive for all to authenticated using(type <> 'low_stock' or public.has_contract_module(restaurant_id,'inventory')) with check(type <> 'low_stock' or public.has_contract_module(restaurant_id,'inventory'));
-- Restrictive policy intersects every permissive role policy, including platform roles.
create policy inventory_contract_gate on public.inventory_items as restrictive for all to authenticated
 using(public.has_contract_module(restaurant_id,'inventory')) with check(public.has_contract_module(restaurant_id,'inventory'));
create function public.protect_product_inventory_link() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if (TG_OP='INSERT' and new.inventory_item_id is not null) or (TG_OP='UPDATE' and (new.inventory_item_id is distinct from old.inventory_item_id or (new.restaurant_id is distinct from old.restaurant_id and new.inventory_item_id is not null))) then
  if not public.has_contract_module(new.restaurant_id,'inventory') then raise exception 'Inventory not included' using errcode='42501'; end if;
  if new.inventory_item_id is not null and not exists(select 1 from public.inventory_items where id=new.inventory_item_id and restaurant_id=new.restaurant_id) then raise exception 'Invalid inventory tenant' using errcode='42501'; end if;
 end if; return new; end $$;
create trigger product_inventory_contract_gate before insert or update of inventory_item_id,restaurant_id on public.menu_products for each row execute function public.protect_product_inventory_link();
revoke all on function public.protect_product_inventory_link() from public,anon,authenticated;
create or replace function public.get_restaurant_financial_report(
  p_restaurant_id uuid,
  p_start_date timestamptz,
  p_end_date timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_is_authorized boolean := false;
  v_gross_revenue_cents bigint := 0;
  v_estimated_service_fee_cents bigint := 0;
  v_closed_tabs_count integer := 0;
  v_average_ticket_cents bigint := 0;
  v_cancelled_items_count integer := 0;
  v_cancelled_amount_cents bigint := 0;
  v_top_products jsonb := '[]'::jsonb;
  v_daily_breakdown jsonb := '[]'::jsonb;
begin
  if not public.has_contract_module(p_restaurant_id,'finance') then raise exception 'Finance not included' using errcode='42501'; end if;
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Autenticação necessária para consultar o relatório financeiro.';
  end if;

  if p_restaurant_id is null or p_start_date is null or p_end_date is null then
    raise exception using errcode = '22023', message = 'Informe o restaurante e o intervalo de datas.';
  end if;

  if p_end_date < p_start_date then
    raise exception using errcode = '22023', message = 'A data final não pode ser anterior à data inicial.';
  end if;

  -- Validar se é admin ativo do restaurante ou platform admin
  select exists (
    select 1
    from public.restaurant_members rm
    where rm.restaurant_id = p_restaurant_id
      and rm.user_id = v_uid
      and rm.role = 'admin'
      and rm.active = true
  ) or public.is_platform_admin()
  into v_is_authorized;

  if not coalesce(v_is_authorized, false) then
    raise exception using errcode = '42501', message = 'Acesso restrito ao administrador do estabelecimento.';
  end if;

  -- Total de comandas encerradas no período
  select count(*)::integer
  into v_closed_tabs_count
  from public.table_tabs t
  where t.restaurant_id = p_restaurant_id
    and t.status = 'closed'
    and t.closed_at >= p_start_date
    and t.closed_at <= p_end_date;

  -- Soma do faturamento bruto (itens ativos de comandas encerradas no período)
  select coalesce(sum(ti.line_total_in_cents), 0)::bigint
  into v_gross_revenue_cents
  from public.table_tabs t
  join public.table_tab_items ti
    on ti.table_tab_id = t.id
   and ti.restaurant_id = t.restaurant_id
  where t.restaurant_id = p_restaurant_id
    and t.status = 'closed'
    and t.closed_at >= p_start_date
    and t.closed_at <= p_end_date
    and ti.status != 'cancelled';

  -- Taxa de serviço estimada (10%) e Ticket Médio
  v_estimated_service_fee_cents := round(v_gross_revenue_cents * 0.10)::bigint;

  if v_closed_tabs_count > 0 then
    v_average_ticket_cents := round(v_gross_revenue_cents::numeric / v_closed_tabs_count)::bigint;
  else
    v_average_ticket_cents := 0;
  end if;

  -- Auditoria de itens cancelados/estornados no período
  select
    coalesce(sum(ti.quantity), 0)::integer,
    coalesce(sum(ti.line_total_in_cents), 0)::bigint
  into
    v_cancelled_items_count,
    v_cancelled_amount_cents
  from public.table_tab_items ti
  where ti.restaurant_id = p_restaurant_id
    and ti.status = 'cancelled'
    and coalesce(ti.cancelled_at, ti.created_at) >= p_start_date
    and coalesce(ti.cancelled_at, ti.created_at) <= p_end_date;

  -- Top 5 produtos mais vendidos em comandas encerradas no período
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_name', top_rows.product_name,
        'quantity_sold', top_rows.quantity_sold,
        'total_revenue_cents', top_rows.total_revenue_cents
      )
    ),
    '[]'::jsonb
  )
  into v_top_products
  from (
    select
      ti.product_name,
      sum(ti.quantity)::integer as quantity_sold,
      sum(ti.line_total_in_cents)::bigint as total_revenue_cents
    from public.table_tabs t
    join public.table_tab_items ti
      on ti.table_tab_id = t.id
     and ti.restaurant_id = t.restaurant_id
    where t.restaurant_id = p_restaurant_id
      and t.status = 'closed'
      and t.closed_at >= p_start_date
      and t.closed_at <= p_end_date
      and ti.status != 'cancelled'
    group by ti.product_name
    order by total_revenue_cents desc, quantity_sold desc, ti.product_name asc
    limit 5
  ) as top_rows;

  -- Evolução diária (agrupado por data de encerramento)
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', daily_rows.day_str,
        'revenue_cents', daily_rows.revenue_cents,
        'tabs_count', daily_rows.tabs_count
      )
      order by daily_rows.day_str asc
    ),
    '[]'::jsonb
  )
  into v_daily_breakdown
  from (
    select
      to_char(t.closed_at at time zone 'UTC', 'YYYY-MM-DD') as day_str,
      count(distinct t.id)::integer as tabs_count,
      coalesce(
        sum(case when ti.status != 'cancelled' then ti.line_total_in_cents else 0 end),
        0
      )::bigint as revenue_cents
    from public.table_tabs t
    left join public.table_tab_items ti
      on ti.table_tab_id = t.id
     and ti.restaurant_id = t.restaurant_id
    where t.restaurant_id = p_restaurant_id
      and t.status = 'closed'
      and t.closed_at >= p_start_date
      and t.closed_at <= p_end_date
    group by to_char(t.closed_at at time zone 'UTC', 'YYYY-MM-DD')
  ) as daily_rows;

  return jsonb_build_object(
    'gross_revenue_cents', v_gross_revenue_cents,
    'estimated_service_fee_cents', v_estimated_service_fee_cents,
    'closed_tabs_count', v_closed_tabs_count,
    'average_ticket_cents', v_average_ticket_cents,
    'cancelled_items_count', v_cancelled_items_count,
    'cancelled_amount_cents', v_cancelled_amount_cents,
    'top_products', v_top_products,
    'daily_breakdown', v_daily_breakdown
  );
end;
$$;
create or replace function public.save_menu_product(
  p_slug text,
  p_id uuid,
  p_revision integer,
  p_values jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.menu_products%rowtype;
  v public.menu_products%rowtype;
  v_prep_min integer;
  v_prep_max integer;
  v_station text;
  v_inv_id uuid;
  v_badge text;
  v_badge_color text;
begin
  rid := public.require_catalog_admin(p_slug);
  select * into v from jsonb_populate_record(null::public.menu_products, p_values);

  if p_id is null or p_revision is null or p_revision < 0 or v.name is null
    or char_length(btrim(v.name)) not between 1 and 120 or v.slug is null
    or char_length(v.slug) > 120 or v.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or v.short_description is null or char_length(v.short_description) > 200
    or v.description is null or char_length(v.description) > 1000
    or v.price_in_cents is null or v.price_in_cents < 0
    or v.available is null or v.featured is null or v.sort_order is null
    or v.sort_order not between 0 and 9999 or v.category_id is null
    or char_length(coalesce(v.dietary_information, '')) > 1000 then
    raise exception using errcode = '22023', message = 'Confira os dados do produto.';
  end if;

  -- Validação da Estação KDS
  v_station := coalesce(nullif(btrim(p_values->>'preparation_station'), ''), 'kitchen');
  if v_station not in ('kitchen', 'bar', 'none') then
    raise exception using errcode = '22023', message = 'Estação de preparo inválida. Use kitchen, bar ou none.';
  end if;

  -- Validação de tempos de preparo (em minutos)
  if p_values ? 'prep_time_min_minutes' and p_values->>'prep_time_min_minutes' is not null and btrim(p_values->>'prep_time_min_minutes') <> '' then
    v_prep_min := (p_values->>'prep_time_min_minutes')::integer;
    if v_prep_min < 1 or v_prep_min > 1440 then
      raise exception using errcode = '22023', message = 'O tempo mínimo de preparo deve ser entre 1 e 1440 minutos.';
    end if;
  else
    v_prep_min := null;
  end if;

  if p_values ? 'prep_time_max_minutes' and p_values->>'prep_time_max_minutes' is not null and btrim(p_values->>'prep_time_max_minutes') <> '' then
    v_prep_max := (p_values->>'prep_time_max_minutes')::integer;
    if v_prep_max < 1 or v_prep_max > 1440 then
      raise exception using errcode = '22023', message = 'O tempo máximo de preparo deve ser entre 1 e 1440 minutos.';
    end if;
  else
    v_prep_max := null;
  end if;

  if v_prep_min is not null and v_prep_max is not null and v_prep_min > v_prep_max then
    raise exception using errcode = '22023', message = 'O tempo mínimo de preparo não pode ser maior que o tempo máximo.';
  end if;

  -- Validação do vínculo opcional de estoque
  if p_values ? 'inventory_item_id' and p_values->>'inventory_item_id' is not null and btrim(p_values->>'inventory_item_id') <> '' then
    v_inv_id := (p_values->>'inventory_item_id')::uuid;
    perform id from public.inventory_items where id = v_inv_id and restaurant_id = rid;
    if not found then
      raise exception using errcode = '22023', message = 'Item de estoque selecionado não pertence a este restaurante.';
    end if;
  else
    if p_values ? 'inventory_item_id' then v_inv_id := null;
    else select inventory_item_id into v_inv_id from public.menu_products where id=p_id and restaurant_id=rid; end if;
  end if;

  -- Validação de badge_text (máximo 50 caracteres)
  v_badge := nullif(btrim(coalesce(p_values->>'badge_text', p_values->>'badgeText', '')), '');
  if v_badge is not null and char_length(v_badge) > 50 then
    raise exception using errcode = '22023', message = 'O selo promocional não pode ultrapassar 50 caracteres.';
  end if;

  -- Validação de badge_color (máximo 30 caracteres)
  v_badge_color := nullif(btrim(coalesce(p_values->>'badge_color', p_values->>'badgeColor', '')), '');
  if v_badge_color is not null and char_length(v_badge_color) > 30 then
    raise exception using errcode = '22023', message = 'A cor do selo promocional é inválida.';
  end if;

  perform id from public.menu_categories where id = v.category_id and restaurant_id = rid for share;
  if not found then
    raise exception using errcode = '22023', message = 'Selecione uma categoria deste restaurante.';
  end if;

  select * into old_row from public.menu_products where id = p_id for update;
  if found then
    if old_row.restaurant_id <> rid then
      raise exception using errcode = '42501', message = 'Produto de outro restaurante.';
    end if;
    if old_row.revision <> p_revision then
      raise exception using errcode = '40001', message = 'Este produto foi alterado. Atualize a lista e abra a edição novamente.';
    end if;

    update public.menu_products set
      category_id = v.category_id,
      name = btrim(v.name),
      short_description = btrim(v.short_description),
      description = btrim(v.description),
      price_in_cents = v.price_in_cents,
      available = v.available,
      featured = v.featured,
      sort_order = v.sort_order,
      dietary_information = nullif(btrim(v.dietary_information), ''),
      prep_time_min_minutes = v_prep_min,
      prep_time_max_minutes = v_prep_max,
      preparation_station = v_station,
      inventory_item_id = v_inv_id,
      badge_text = v_badge,
      badge_color = v_badge_color,
      revision = revision + 1
    where id = p_id;
  else
    if p_revision <> 0 then
      raise exception using errcode = '22023', message = 'Produto não encontrado. Atualize a lista.';
    end if;

    insert into public.menu_products (
      id, restaurant_id, category_id, catalog_key, slug, name,
      short_description, description, price_in_cents, available, featured,
      sort_order, dietary_information, prep_time_min_minutes, prep_time_max_minutes,
      preparation_station, inventory_item_id, badge_text, badge_color
    ) values (
      p_id, rid, v.category_id, p_id::text, v.slug, btrim(v.name),
      btrim(v.short_description), btrim(v.description), v.price_in_cents, v.available, v.featured,
      v.sort_order, nullif(btrim(v.dietary_information), ''), v_prep_min, v_prep_max,
      v_station, v_inv_id, v_badge, v_badge_color
    );
  end if;

  return p_id;
end;
$$;
create or replace function public.save_restaurant_identity(
  p_slug text,
  p_revision integer,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.restaurants%rowtype;
  v public.restaurants%rowtype;
  field text;
  media jsonb;
  path text;
  primary_l numeric;
  text_l numeric;
  bg_l numeric;
  v_fee numeric;
  v_tz text;
  v_google_url text;
  v_brand_primary text;
  v_header_name text;
  v_header_sub text;
  v_menu_theme text;
begin
  if p_values ?| array['contract_rights_model','contractRightsModel'] then raise exception 'Contract rights payload forbidden' using errcode='42501'; end if;
  rid := public.require_catalog_admin(p_slug);
  select * into old_row from public.restaurants where id = rid for update;
  if p_revision is distinct from old_row.revision then
    raise exception using errcode = '40001', message = 'A identidade foi alterada. Recarregue antes de editar novamente.';
  end if;
  select * into v from jsonb_populate_record(null::public.restaurants, p_values);
  if v.name is null or char_length(btrim(v.name)) not between 1 and 120
  or v.subtitle is null or char_length(v.subtitle) > 120
  or v.description is null or char_length(v.description) > 1000
  or v.address is null or char_length(v.address) > 300
  or v.phone is null or char_length(v.phone) > 40
  or v.opening_hours is null or char_length(v.opening_hours) > 500 then
    raise exception using errcode = '22023', message = 'Confira os dados e os limites dos campos.';
  end if;

  if p_values ? 'service_fee_percent' then
    v_fee := (p_values->>'service_fee_percent')::numeric;
    if v_fee is null or v_fee < 0 or v_fee > 30 then
      raise exception using errcode = '22023', message = 'A taxa de serviço deve estar entre 0% e 30%.';
    end if;
  else
    v_fee := old_row.service_fee_percent;
  end if;

  if p_values ? 'timezone' then
    v_tz := btrim(p_values->>'timezone');
    if v_tz is null or length(v_tz) = 0 then
      raise exception using errcode = '22023', message = 'Informe um fuso horário válido.';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_timezone_names where name = v_tz
    ) then
      raise exception using errcode = '22023', message = 'Fuso horário não reconhecido pelo sistema.';
    end if;
  else
    v_tz := old_row.timezone;
  end if;

  if p_values ? 'google_review_url' then
    v_google_url := nullif(btrim(p_values->>'google_review_url'), '');
    if v_google_url is not null then
      if char_length(v_google_url) not between 10 and 500
      or v_google_url !~* '^https://([a-z0-9-]+\.)*(google\.(com|com\.br)|g\.page|goo\.gl)/' then
        raise exception using errcode = '22023', message = 'Informe um link válido do Perfil da Empresa no Google (ex: https://g.page/r/.../review ou https://maps.app.goo.gl/...).';
      end if;
    end if;
  else
    v_google_url := old_row.google_review_url;
  end if;

  -- Processamento das cores da paleta
  v_brand_primary := coalesce(
    nullif(btrim(p_values->>'brand_primary_color'), ''),
    nullif(btrim(p_values->>'brandPrimaryColor'), ''),
    v.theme_primary,
    old_row.brand_primary_color,
    '#EA580C'
  );
  if v_brand_primary !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor primária da marca inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  v_header_name := coalesce(
    nullif(btrim(p_values->>'header_name_color'), ''),
    nullif(btrim(p_values->>'headerNameColor'), ''),
    old_row.header_name_color,
    '#1C1917'
  );
  if v_header_name !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor do nome do restaurante inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  v_header_sub := coalesce(
    nullif(btrim(p_values->>'header_subtitle_color'), ''),
    nullif(btrim(p_values->>'headerSubtitleColor'), ''),
    old_row.header_subtitle_color,
    '#57534E'
  );
  if v_header_sub !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor do complemento inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  -- Extração e validação do layout do cardápio (menu_theme)
  v_menu_theme := coalesce(
    nullif(btrim(p_values->>'menu_theme'), ''),
    nullif(btrim(p_values->>'menuTheme'), ''),
    'classic'
  );
  if v_menu_theme not in ('classic', 'takeat_premium') then
    raise exception using errcode = '22023', message = 'INVALID_MENU_THEME';
  end if;

  primary_l := public.hex_luminance(v_brand_primary);
  bg_l := public.hex_luminance(v.theme_background);
  text_l := public.hex_luminance(v.theme_text);
  if primary_l is null or bg_l is null or text_l is null or 1.05 / (primary_l + 0.05) < 4.5
  or (greatest(bg_l, text_l) + 0.05) / (least(bg_l, text_l) + 0.05) < 4.5 or 1.05 / (text_l + 0.05) < 4.5 then
    raise exception using errcode = '22023', message = 'Ajuste as cores: texto, cards e botões precisam de contraste mínimo de 4,5:1.';
  end if;

  foreach field in array array['logo', 'cover'] loop
    if not (p_values ? field) then
      raise exception using errcode = '22023', message = 'Informe logo e capa.';
    end if;
    media := p_values->field;
    if media is not null and media <> 'null'::jsonb then
      path := media->>'storagePath';
      if jsonb_typeof(media) is distinct from 'object' or path is null
      or path !~ ('^' || rid::text || '/identity/[0-9a-f-]{36}\.webp$')
      or jsonb_typeof(media->'url') is distinct from 'string'
      or media->>'url' !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/restaurant-images/'
      or right(media->>'url', char_length(path) + 1) <> '/' || path then
        raise exception using errcode = '22023', message = 'Envie logo e capa pelo painel deste restaurante.';
      end if;
      perform id from storage.objects where bucket_id = 'restaurant-images' and name = path for share;
      if not found then
        raise exception using errcode = '22023', message = 'A imagem ainda não foi enviada.';
      end if;
      media := jsonb_build_object('url', media->>'url', 'storagePath', path);
    end if;
    if field = 'logo' then v.logo := nullif(media, 'null'::jsonb); else v.cover := nullif(media, 'null'::jsonb); end if;
  end loop;

  if p_values ? 'contact_channels' and not public.valid_contact_channels(p_values->'contact_channels') then
    raise exception 'Canais de contato invalidos.' using errcode='22023';
  end if;
  update public.restaurants set
    contact_channels = case when p_values ? 'contact_channels' then p_values->'contact_channels' else old_row.contact_channels end,
    name = btrim(v.name),
    subtitle = btrim(v.subtitle),
    description = btrim(v.description),
    address = btrim(v.address),
    phone = btrim(v.phone),
    opening_hours = btrim(v.opening_hours),
    theme_primary = upper(v_brand_primary),
    theme_background = upper(v.theme_background),
    theme_text = upper(v.theme_text),
    brand_primary_color = upper(v_brand_primary),
    header_name_color = upper(v_header_name),
    header_subtitle_color = upper(v_header_sub),
    menu_theme = v_menu_theme,
    logo = v.logo,
    cover = v.cover,
    service_fee_percent = v_fee,
    timezone = v_tz,
    google_review_url = v_google_url
  where id = rid;

  return public.get_public_restaurant(p_slug);
end;
$$;
commit;
