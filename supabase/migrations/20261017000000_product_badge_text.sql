begin;

-- ============================================================================
-- 1. ADICIONA A COLUNA badge_text NA TABELA public.menu_products
-- ============================================================================
alter table public.menu_products
  add column if not exists badge_text text check (char_length(badge_text) <= 50),
  add column if not exists badge_color text check (char_length(badge_color) <= 30);

-- ============================================================================
-- 2. ATUALIZAÇÃO DA RPC public.save_menu_product COM PERSISTÊNCIA DE badge_text
-- ============================================================================
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
    v_inv_id := null;
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

revoke all on function public.save_menu_product(text, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_menu_product(text, uuid, integer, jsonb) to authenticated;

-- ============================================================================
-- 3. ATUALIZAÇÃO DA RPC public.get_public_menu COM badgeText E badge_text
-- ============================================================================
create or replace function public.get_public_menu(p_restaurant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
select jsonb_build_object(
  'restaurantId', restaurant.id,
  'categories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', category.id, 'restaurantId', category.restaurant_id,
      'name', category.name, 'slug', category.slug, 'sortOrder', category.sort_order
    ) order by category.sort_order, category.id)
    from public.menu_categories as category
    where category.restaurant_id = restaurant.id and category.active
  ), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', product.id, 'restaurantId', product.restaurant_id,
      'categoryId', product.category_id, 'slug', product.slug,
      'name', product.name, 'shortDescription', product.short_description,
      'description', product.description, 'priceInCents', product.price_in_cents,
      'available', product.available, 'featured', product.featured,
      'sortOrder', product.sort_order, 'images', product.images,
      'coverImageId', product.cover_image_id, 'video', product.video,
      'dietaryInformation', product.dietary_information,
      'prepTimeMinMinutes', product.prep_time_min_minutes,
      'prepTimeMaxMinutes', product.prep_time_max_minutes,
      'preparationStation', product.preparation_station,
      'inventoryItemId', product.inventory_item_id,
      'inventory_item_id', product.inventory_item_id,
      'isOutOfStock', (product.inventory_item_id is not null and coalesce(inv.current_quantity, 0) <= 0),
      'is_out_of_stock', (product.inventory_item_id is not null and coalesce(inv.current_quantity, 0) <= 0),
      'badgeText', product.badge_text,
      'badge_text', product.badge_text,
      'badgeColor', product.badge_color,
      'badge_color', product.badge_color,
      'likesCount', coalesce(product.likes_count, 0),
      'commentsCount', coalesce(product.comments_count, 0)
    ) order by product.sort_order, product.id)
    from public.menu_products as product
    join public.menu_categories as category
      on category.id = product.category_id and category.restaurant_id = product.restaurant_id
    left join public.inventory_items as inv
      on inv.id = product.inventory_item_id
    where product.restaurant_id = restaurant.id and category.active
  ), '[]'::jsonb)
)
from public.restaurants as restaurant
where restaurant.slug = p_restaurant_slug and restaurant.active;
$$;

revoke all on function public.get_public_menu(text) from public, anon, authenticated;
grant execute on function public.get_public_menu(text) to anon, authenticated;

commit;
