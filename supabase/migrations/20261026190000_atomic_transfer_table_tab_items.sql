-- ============================================================================
-- Migração incremental: 20261026190000_atomic_transfer_table_tab_items.sql
-- Transferência segura, transacional e atômica de itens entre comandas (mesma mesa ou entre mesas)
--
-- Objetivos e Regras:
-- 1. Operação atômica no banco, preservando o histórico, valores unitários e status de produção (KDS).
-- 2. Não cancela nem recria itens (preserva id e timestamps originais).
-- 3. Valida autorização de staff (admin ou garçom responsável) no servidor.
-- 4. Valida estados abertos das comandas e atendimentos de origem e destino.
-- 5. Aplica ordenação determinística de bloqueios (ORDER BY id FOR UPDATE) para prevenir deadlocks.
-- 6. Registra auditoria completa em public.table_tab_item_transfers.
-- 7. Atualiza o trigger public.validate_table_tab_item_write para permitir a transferência de itens ativos.
-- ============================================================================

-- 1. Tabela de Auditoria de Transferência de Itens
create table if not exists public.table_tab_item_transfers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  item_id uuid not null references public.table_tab_items(id) on delete cascade,
  source_table_tab_id uuid not null,
  source_table_visit_id uuid not null,
  source_restaurant_table_id uuid not null,
  target_table_tab_id uuid not null,
  target_table_visit_id uuid not null,
  target_restaurant_table_id uuid not null,
  transferred_by_member_id uuid not null references public.restaurant_members(id) on delete restrict,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint table_tab_item_transfers_reason_length check (
    char_length(btrim(reason)) between 3 and 300
  )
);

create index if not exists table_tab_item_transfers_item_idx
  on public.table_tab_item_transfers(item_id);

create index if not exists table_tab_item_transfers_restaurant_idx
  on public.table_tab_item_transfers(restaurant_id);

create index if not exists table_tab_item_transfers_created_at_idx
  on public.table_tab_item_transfers(created_at desc);

alter table public.table_tab_item_transfers enable row level security;

drop policy if exists table_tab_item_transfers_read on public.table_tab_item_transfers;
create policy table_tab_item_transfers_read on public.table_tab_item_transfers
  for select to authenticated
  using (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = table_tab_item_transfers.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role in ('admin', 'waiter')
    )
  );

revoke all privileges on table public.table_tab_item_transfers from public, anon;
grant select on table public.table_tab_item_transfers to authenticated;

-- 2. Atualização do Trigger de Validação de Itens para Suporte a Transferência
create or replace function public.validate_table_tab_item_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_product public.menu_products%rowtype;
  is_transfer boolean;
begin
  if TG_OP = 'UPDATE' then
    if old.status = 'cancelled' then
      raise exception using errcode = '22023', message = 'Um lançamento cancelado não pode ser alterado.';
    end if;

    is_transfer := (new.table_tab_id is distinct from old.table_tab_id);

    if is_transfer then
      -- Validações estritas de transferência: apenas itens ativos, mesmo restaurante e imutabilidade dos dados comerciais
      if old.status <> 'active' or new.status <> 'active' then
        raise exception using errcode = '22023', message = 'Apenas lançamentos ativos podem ser transferidos.';
      end if;

      if new.restaurant_id is distinct from old.restaurant_id then
        raise exception using errcode = '22023', message = 'Transferência entre restaurantes diferentes não é permitida.';
      end if;

      if new.id is distinct from old.id
        or new.product_id is distinct from old.product_id
        or new.product_name is distinct from old.product_name
        or new.unit_price_in_cents is distinct from old.unit_price_in_cents
        or new.quantity is distinct from old.quantity
        or new.added_by_member_id is distinct from old.added_by_member_id
        or new.created_at is distinct from old.created_at
        or new.preparation_station is distinct from old.preparation_station
      then
        raise exception using errcode = '22023', message = 'Os dados comerciais e históricos do item não podem ser alterados na transferência.';
      end if;
    else
      -- Se não é transferência entre comandas, mesa, atendimento e comanda não podem ser modificados isoladamente
      if new.id is distinct from old.id
        or new.restaurant_id is distinct from old.restaurant_id
        or new.restaurant_table_id is distinct from old.restaurant_table_id
        or new.table_visit_id is distinct from old.table_visit_id
        or new.product_id is distinct from old.product_id
        or new.product_name is distinct from old.product_name
        or new.unit_price_in_cents is distinct from old.unit_price_in_cents
        or new.quantity is distinct from old.quantity
        or new.added_by_member_id is distinct from old.added_by_member_id
        or new.created_at is distinct from old.created_at
        or new.preparation_station is distinct from old.preparation_station
      then
        raise exception using errcode = '22023', message = 'Cancele o lançamento e registre outro para corrigir o consumo.';
      end if;

      if new.status <> 'cancelled' and new.status <> old.status then
        raise exception using errcode = '22023', message = 'A única alteração permitida é cancelar o lançamento ou atualizar a produção.';
      end if;
    end if;

    if new.status = 'active' then
      if new.cancelled_at is not null
        or new.cancelled_by_member_id is not null
        or new.cancellation_reason is not null
      then
        raise exception using errcode = '22023', message = 'Dados de cancelamento inválidos.';
      end if;
    end if;
  end if;

  perform restaurant_table.id from public.restaurant_tables as restaurant_table
  where restaurant_table.id = new.restaurant_table_id
    and restaurant_table.restaurant_id = new.restaurant_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Mesa não encontrada.';
  end if;

  select visit.* into target_visit from public.table_visits as visit
  where visit.id = new.table_visit_id and visit.restaurant_id = new.restaurant_id
    and visit.restaurant_table_id = new.restaurant_table_id for update;
  if not found or target_visit.status <> 'open' then
    raise exception using errcode = '22023', message = 'O atendimento precisa estar aberto.';
  end if;

  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = new.table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = new.restaurant_id
    and tab.restaurant_table_id = new.restaurant_table_id for update;
  if not found or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'A comanda precisa estar aberta.';
  end if;

  if TG_OP = 'INSERT' then
    if new.status <> 'active' or (target_visit.assigned_member_id is not null and new.added_by_member_id is distinct from target_visit.assigned_member_id) then
      raise exception using errcode = '22023', message = 'Lançamento inválido para este atendimento.';
    end if;
    select product.* into target_product from public.menu_products as product
    where product.id = new.product_id and product.restaurant_id = new.restaurant_id for share;
    if not found or not target_product.available then
      raise exception using errcode = '22023', message = 'Produto indisponível.';
    end if;
    if new.product_name is distinct from target_product.name
      or new.unit_price_in_cents is distinct from target_product.price_in_cents
    then
      raise exception using errcode = '22023', message = 'O nome e o preço devem corresponder ao catálogo do servidor.';
    end if;
  elsif new.status = 'cancelled' then
    if target_visit.assigned_member_id is not null and new.cancelled_by_member_id is distinct from target_visit.assigned_member_id then
      raise exception using errcode = '22023', message = 'Responsável pelo cancelamento inválido.';
    end if;
  end if;

  return new;
end;
$$;

revoke all privileges on function public.validate_table_tab_item_write() from public, anon, authenticated;

-- 3. RPC Transacional e Atômica: public.transfer_table_tab_items
drop function if exists public.transfer_table_tab_items(text, uuid, uuid, uuid[], text);

create or replace function public.transfer_table_tab_items(
  p_restaurant_slug text,
  p_source_tab_id uuid,
  p_target_tab_id uuid,
  p_item_ids uuid[],
  p_reason text
)
returns setof public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  v_restaurant_id uuid;
  v_member_id uuid;
  v_member_role text;
  normalized_reason text;
  distinct_item_ids uuid[];
  v_item_count integer;
  v_source_tab public.table_tabs%rowtype;
  v_target_tab public.table_tabs%rowtype;
  v_source_visit public.table_visits%rowtype;
  v_target_visit public.table_visits%rowtype;
begin
  -- 1. Validação básica de parâmetros
  if p_restaurant_slug is null or btrim(p_restaurant_slug) = '' then
    raise exception using errcode = '22023', message = 'Informe o identificador do restaurante.';
  end if;

  if p_source_tab_id is null or p_target_tab_id is null then
    raise exception using errcode = '22023', message = 'Informe a comanda de origem e de destino.';
  end if;

  if p_source_tab_id = p_target_tab_id then
    raise exception using errcode = '22023', message = 'A comanda de origem e de destino não podem ser iguais.';
  end if;

  if p_item_ids is null or coalesce(cardinality(p_item_ids), 0) = 0 then
    raise exception using errcode = '22023', message = 'Nenhum item informado para transferência.';
  end if;

  normalized_reason := btrim(p_reason);
  if normalized_reason is null or char_length(normalized_reason) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'Informe um motivo entre 3 e 300 caracteres.';
  end if;

  -- Remove duplicatas do array de itens recebido
  select array_agg(distinct item_id) into distinct_item_ids
  from unnest(p_item_ids) as item_id;

  if distinct_item_ids is null or coalesce(cardinality(distinct_item_ids), 0) = 0 then
    raise exception using errcode = '22023', message = 'Nenhum item válido informado para transferência.';
  end if;

  -- 2. Autenticação e Autorização do Colaborador
  current_user_id := auth.uid();
  if current_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Entre com uma conta da equipe.';
  end if;

  select id into v_restaurant_id
  from public.restaurants
  where slug = p_restaurant_slug and active = true
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'Restaurante indisponível.';
  end if;

  select id, role into v_member_id, v_member_role
  from public.restaurant_members
  where restaurant_id = v_restaurant_id
    and user_id = current_user_id
    and active = true
    and role in ('admin', 'waiter')
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  -- 3. Identificação e Validação das Comandas
  select * into v_source_tab
  from public.table_tabs
  where id = p_source_tab_id and restaurant_id = v_restaurant_id;

  if not found then
    raise exception using errcode = '22023', message = 'Comanda de origem não encontrada neste restaurante.';
  end if;

  select * into v_target_tab
  from public.table_tabs
  where id = p_target_tab_id and restaurant_id = v_restaurant_id;

  if not found then
    raise exception using errcode = '22023', message = 'Comanda de destino não encontrada neste restaurante.';
  end if;

  -- 4. Bloqueios Ordenados e Determinísticos contra Deadlocks
  -- 4.1 Bloqueio de Mesas (ORDER BY id)
  perform 1
  from public.restaurant_tables
  where id in (v_source_tab.restaurant_table_id, v_target_tab.restaurant_table_id)
    and restaurant_id = v_restaurant_id
  order by id
  for update;

  -- 4.2 Bloqueio de Atendimentos / Visitas (ORDER BY id)
  perform 1
  from public.table_visits
  where id in (v_source_tab.table_visit_id, v_target_tab.table_visit_id)
    and restaurant_id = v_restaurant_id
  order by id
  for update;

  select * into v_source_visit from public.table_visits where id = v_source_tab.table_visit_id;
  select * into v_target_visit from public.table_visits where id = v_target_tab.table_visit_id;

  -- 4.3 Bloqueio das Comandas (ORDER BY id)
  perform 1
  from public.table_tabs
  where id in (p_source_tab_id, p_target_tab_id)
    and restaurant_id = v_restaurant_id
  order by id
  for update;

  select * into v_source_tab from public.table_tabs where id = p_source_tab_id;
  select * into v_target_tab from public.table_tabs where id = p_target_tab_id;

  -- 5. Validação de Estados das Visitas e Comandas
  if v_source_visit.status <> 'open' or v_source_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'A comanda e o atendimento de origem precisam estar abertos.';
  end if;

  if v_target_visit.status <> 'open' or v_target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'A comanda e o atendimento de destino precisam estar abertos.';
  end if;

  -- 6. Validação de Atribuição de Garçom
  if v_member_role = 'waiter' then
    if v_source_visit.assigned_member_id is not null and v_source_visit.assigned_member_id <> v_member_id then
      raise exception using errcode = '42501', message = 'Somente o responsável pelo atendimento pode transferir itens desta mesa.';
    end if;
  end if;

  -- 7. Bloqueio e Validação dos Itens a Transferir
  perform 1
  from public.table_tab_items
  where id = any(distinct_item_ids)
  order by id
  for update;

  -- Confere se todos os itens solicitados pertencem à comanda de origem e ao restaurante
  select count(*) into v_item_count
  from public.table_tab_items
  where id = any(distinct_item_ids)
    and table_tab_id = p_source_tab_id
    and restaurant_id = v_restaurant_id;

  if v_item_count <> cardinality(distinct_item_ids) then
    raise exception using errcode = '22023', message = 'Um ou mais itens informados não foram encontrados na comanda de origem.';
  end if;

  -- Confere se todos os itens estão ativos
  if exists (
    select 1
    from public.table_tab_items
    where id = any(distinct_item_ids)
      and status <> 'active'
  ) then
    raise exception using errcode = '22023', message = 'Apenas itens ativos podem ser transferidos.';
  end if;

  -- 8. Executa a Transferência Atômica dos Itens
  -- Preserva id, preços unitários, quantidades, timestamps de criação e estado KDS
  return query
  update public.table_tab_items as item set
    table_tab_id = p_target_tab_id,
    table_visit_id = v_target_tab.table_visit_id,
    restaurant_table_id = v_target_tab.restaurant_table_id
  where item.id = any(distinct_item_ids)
  returning *;

  -- 9. Registro de Auditoria da Transferência
  insert into public.table_tab_item_transfers (
    restaurant_id,
    item_id,
    source_table_tab_id,
    source_table_visit_id,
    source_restaurant_table_id,
    target_table_tab_id,
    target_table_visit_id,
    target_restaurant_table_id,
    transferred_by_member_id,
    reason
  )
  select
    v_restaurant_id,
    item_id,
    v_source_tab.id,
    v_source_tab.table_visit_id,
    v_source_tab.restaurant_table_id,
    v_target_tab.id,
    v_target_tab.table_visit_id,
    v_target_tab.restaurant_table_id,
    v_member_id,
    normalized_reason
  from unnest(distinct_item_ids) as item_id;

  return;
end;
$$;

revoke all privileges on function public.transfer_table_tab_items(text, uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.transfer_table_tab_items(text, uuid, uuid, uuid[], text) to authenticated;
