begin;

-- pending = recebido; attended = aceito/em atendimento; completed = atendimento concluído.
-- Aceitar NÃO libera outro chamado ativo. A conclusão explícita libera novo ciclo/ID.
-- As definições anteriores são preservadas nas migrations históricas.
create schema attendance_private;
revoke all on schema attendance_private from public, anon, authenticated;

create or replace function public.request_waiter(
  p_restaurant_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_table_id uuid;
  target_visit_id uuid;
  target_session public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
  rate_limit public.guest_service_request_limits%rowtype;
  checked_at timestamptz;
  retry_after_seconds integer;
  request_result text;
begin
  current_user_id := auth.uid();

  if current_user_id is null
    or not coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Utilize uma sessão de cliente para chamar o garçom.';
  end if;

  if p_table_number is null
    or p_table_number < 1
    or p_table_number > 999
  then
    raise exception using
      errcode = '22023',
      message = 'Informe um número de mesa válido.';
  end if;

  select restaurant.id
  into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  -- Serializar as operações desta mesa.
  select restaurant_table.id
  into target_table_id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.table_number = p_table_number
    and restaurant_table.active = true
  for update;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Mesa inexistente ou indisponível.';
  end if;

  insert into public.guest_service_request_limits (user_id)
  values (current_user_id)
  on conflict (user_id) do nothing;

  select limiter.*
  into rate_limit
  from public.guest_service_request_limits as limiter
  where limiter.user_id = current_user_id
  for update;

  checked_at := clock_timestamp();

  if rate_limit.window_started_at + interval '1 minute'
    <= checked_at
  then
    update public.guest_service_request_limits
    set
      window_started_at = checked_at,
      attempts = 0
    where user_id = current_user_id
    returning * into rate_limit;
  end if;

  if rate_limit.attempts >= 5 then
    retry_after_seconds := greatest(
      1,
      ceil(
        extract(epoch from (
          rate_limit.window_started_at
          + interval '1 minute'
          - checked_at
        ))
      )::integer
    );

    return jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', retry_after_seconds
    );
  end if;

  update public.guest_service_request_limits
  set attempts = attempts + 1
  where user_id = current_user_id;

  -- Criar ou recuperar a sessão do próprio cliente.
  -- Esta operação não gera código nem confirma presença.
  target_session := public.start_guest_session(
    p_restaurant_slug,
    p_table_number
  );

  -- A chamada inicial pode existir sem atendimento aberto.
  select visit.id
  into target_visit_id
  from public.table_visits as visit
  where visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id
    and visit.status = 'open'
  for update;

  -- Reutilizar o chamado pendente da mesa, se existir.
  select request.*
  into target_request
  from public.service_requests as request
  where request.restaurant_id = target_restaurant_id
    and request.restaurant_table_id = target_table_id
    and request.request_type = 'waiter'
    and request.status in ('pending', 'attended')
  order by request.created_at desc, request.id desc limit 1
  for update;

  if found then
    request_result := 'existing';

    -- Vincular a chamada inicial ao atendimento,
    -- caso ele tenha sido aberto posteriormente.
    if target_request.table_visit_id is null
      and target_visit_id is not null
    then
      update public.service_requests
      set table_visit_id = target_visit_id
      where id = target_request.id
      returning * into target_request;
    end if;
  else
    insert into public.service_requests (
      restaurant_id,
      restaurant_table_id,
      table_visit_id,
      request_type,
      created_at
    )
    values (
      target_restaurant_id,
      target_table_id,
      target_visit_id,
      'waiter',
      clock_timestamp()
    )
    returning * into target_request;

    request_result := 'created';
  end if;

  -- Cada cliente acompanha o chamado por seu próprio vínculo.
  insert into public.service_request_guests (
    service_request_id,
    guest_session_id,
    restaurant_id,
    restaurant_table_id
  )
  values (
    target_request.id,
    target_session.id,
    target_restaurant_id,
    target_table_id
  )
  on conflict (service_request_id, guest_session_id)
  do nothing;

  return jsonb_build_object(
    'status', request_result,
    'guest_session_id', target_session.id,
    'request', to_jsonb(target_request)
  );
end;
$$;

create or replace function public.request_table_tab_bill(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_include_service_fee boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_table_id uuid;
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_guest public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
  rate_limit public.guest_service_request_limits%rowtype;
  checked_at timestamptz;
  retry_after_seconds integer;
begin
  current_user_id := auth.uid();
  if current_user_id is null or not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Utilize seu acesso de cliente para pedir a conta.';
  end if;
  if p_table_tab_id is null then
    raise exception using errcode = '22023', message = 'Informe a comanda.';
  end if;

  -- 1. Restaurante (FOR SHARE)
  select restaurant.id into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug and restaurant.active for share;
  if not found then
    raise exception using errcode = '42501', message = 'Restaurante indisponível.';
  end if;

  -- 2. Mesa e Visita
  select tab.restaurant_table_id, tab.table_visit_id
  into target_table_id, target_visit_id
  from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.restaurant_id = target_restaurant_id;
  if not found then
    raise exception using errcode = '42501', message = 'Comanda indisponível para este acesso.';
  end if;

  -- 3. Mesa (FOR UPDATE)
  perform restaurant_table.id from public.restaurant_tables as restaurant_table
  where restaurant_table.id = target_table_id and restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.active for update;
  if not found then
    raise exception using errcode = '22023', message = 'Mesa indisponível.';
  end if;

  -- 4. Rate Limiter (5 por minuto compartilhado)
  insert into public.guest_service_request_limits(user_id) values (current_user_id)
  on conflict (user_id) do nothing;
  select limiter.* into rate_limit from public.guest_service_request_limits as limiter
  where limiter.user_id = current_user_id for update;
  checked_at := clock_timestamp();
  if rate_limit.window_started_at + interval '1 minute' <= checked_at then
    update public.guest_service_request_limits set window_started_at = checked_at, attempts = 0
    where user_id = current_user_id returning * into rate_limit;
  end if;
  if rate_limit.attempts >= 5 then
    retry_after_seconds := greatest(1, ceil(extract(epoch from (
      rate_limit.window_started_at + interval '1 minute' - checked_at
    )))::integer);
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', retry_after_seconds);
  end if;
  update public.guest_service_request_limits set attempts = attempts + 1 where user_id = current_user_id;

  -- 5. Atendimento (FOR UPDATE)
  select visit.* into target_visit from public.table_visits as visit
  where visit.id = target_visit_id and visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id for update;
  if not found or target_visit.status <> 'open' then
    raise exception using errcode = '22023', message = 'O atendimento desta mesa já foi encerrado.';
  end if;

  -- 6. Comanda (FOR UPDATE)
  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_restaurant_id and tab.restaurant_table_id = target_table_id for update;
  if not found or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Esta comanda não está aberta.';
  end if;

  -- 7. Validar vínculo da sessão do cliente
  select guest.* into target_guest from public.guest_sessions as guest
  join public.table_tab_guests as linked_guest on linked_guest.guest_session_id = guest.id
    and linked_guest.table_visit_id = guest.table_visit_id
    and linked_guest.restaurant_id = guest.restaurant_id
    and linked_guest.restaurant_table_id = guest.restaurant_table_id
  where linked_guest.table_tab_id = target_tab.id
    and guest.restaurant_id = target_restaurant_id and guest.restaurant_table_id = target_table_id
    and guest.table_visit_id = target_visit.id and guest.user_id = current_user_id
    and guest.status = 'active' and guest.expires_at > clock_timestamp()
  for update of guest, linked_guest;
  if not found then
    raise exception using errcode = '42501', message = 'Sua presença precisa estar confirmada e vinculada a esta comanda.';
  end if;

  -- 8. Chamado existente ou novo
  select request.* into target_request from public.service_requests as request
  where request.table_tab_id = target_tab.id and request.restaurant_id = target_restaurant_id
    and request.request_type = 'bill' and request.status in ('pending', 'attended')
    order by request.created_at desc, request.id desc limit 1 for update;

  if found then
    -- A solicitação pendente já existe para a comanda: preserva a preferência do solicitante original
    -- sem permitir que outro participante sobrescreva include_service_fee.
    return jsonb_build_object('status', 'existing', 'request', to_jsonb(target_request));
  end if;

  insert into public.service_requests(
    restaurant_id, restaurant_table_id, table_visit_id, table_tab_id, request_type, include_service_fee, created_at
  ) values (
    target_restaurant_id, target_table_id, target_visit.id, target_tab.id, 'bill', coalesce(p_include_service_fee, false), clock_timestamp()
  ) returning * into target_request;

  return jsonb_build_object('status', 'created', 'request', to_jsonb(target_request));
end;
$$;

create or replace function public.get_waiter_request_state(
  p_restaurant_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_session public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
  v_waiter_name text;
begin
  -- Contas da equipe não recebem o estado de um cliente.
  if auth.uid() is null
    or not coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    return jsonb_build_object(
      'guest_session_id', null,
      'request', null
    );
  end if;

  target_session := public.get_guest_session(
    p_restaurant_slug,
    p_table_number
  );

  if target_session.id is null then
    return jsonb_build_object(
      'guest_session_id', null,
      'request', null
    );
  end if;

  select request.*
  into target_request
  from public.service_requests as request
  join public.service_request_guests as link
    on link.service_request_id = request.id
  where link.guest_session_id = target_session.id
    and request.restaurant_id = target_session.restaurant_id
    and request.restaurant_table_id = target_session.restaurant_table_id
    and (request.table_visit_id is null or exists (
      select 1 from public.table_visits v where v.id=request.table_visit_id and v.status='open'
        and v.restaurant_id=target_session.restaurant_id and v.restaurant_table_id=target_session.restaurant_table_id
        and (target_session.table_visit_id is null or v.id=target_session.table_visit_id)))
    and request.request_type = 'waiter'
    and request.status in ('pending', 'attended')
  order by request.created_at desc, request.id desc
  limit 1;

  if target_request.resolved_by_member_id is not null then
    select m.display_name into v_waiter_name
    from public.restaurant_members as m
    where m.id = target_request.resolved_by_member_id;
  end if;

  return jsonb_build_object(
    'guest_session_id', target_session.id,
    'request',
      case
        when target_request.id is null then null
        else to_jsonb(target_request) || jsonb_build_object('waiter_name', v_waiter_name)
      end
  );
end;
$$;

create or replace function attendance_private.complete_request(
  p_restaurant_slug text,
  p_service_request_id uuid,
  p_request_type text
)
returns public.service_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_member_id uuid;
  target_member_role text;
  target_table_id uuid;
  target_request public.service_requests%rowtype;
begin
  current_user_id := auth.uid();

  if current_user_id is null
    or coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe.';
  end if;

  if p_service_request_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe o chamado que deseja concluir.';
  end if;

  select restaurant.id
  into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  select member.id, member.role
  into target_member_id, target_member_role
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if target_member_id is null then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select request.restaurant_table_id
  into target_table_id
  from public.service_requests as request
  where request.id = p_service_request_id
    and request.restaurant_id = target_restaurant_id;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Chamado não encontrado neste restaurante.';
  end if;

  -- Serializar operações da mesa
  perform restaurant_table.id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.id = target_table_id
    and restaurant_table.restaurant_id = target_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Mesa não encontrada.';
  end if;

  select request.*
  into target_request
  from public.service_requests as request
  where request.id = p_service_request_id
    and request.restaurant_id = target_restaurant_id
    and request.restaurant_table_id = target_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Chamado não encontrado.';
  end if;

  if p_request_type not in ('waiter', 'bill') or target_request.request_type <> p_request_type then
    raise exception using
      errcode = '22023',
      message = 'Tipo de chamado incompatível.';
  end if;

  if target_request.status = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'Este chamado foi cancelado.';
  end if;

  -- REGRA DE AUTORIZAÇÃO: O responsável pelo atendimento pode concluir.
  -- Administrador ativo pode realizar conclusão excepcional.
  -- Outro garçom não pode concluir atendimento alheio.
  if target_request.resolved_by_member_id is not null
    and target_request.resolved_by_member_id <> target_member_id
    and target_member_role <> 'admin'
  then
    raise exception using
      errcode = '42501',
      message = 'Somente o funcionário responsável ou um administrador pode concluir este atendimento.';
  end if;

  -- Idempotência: se já estiver concluído, retorna o registro
  if target_request.status = 'completed' then
    return target_request;
  end if;

  if target_request.status <> 'attended' then
    raise exception using
      errcode = '22023',
      message = 'Apenas chamados em atendimento podem ser concluídos.';
  end if;

  update public.service_requests
  set
    status = 'completed',
    resolved_at = greatest(clock_timestamp(), created_at),
    resolved_by_member_id = coalesce(target_request.resolved_by_member_id, target_member_id)
  where id = target_request.id
  returning * into target_request;

  return target_request;
end;
$$;

create or replace function public.complete_waiter_request(p_restaurant_slug text, p_service_request_id uuid)
returns public.service_requests language sql security definer set search_path = '' as $$
  select attendance_private.complete_request(p_restaurant_slug, p_service_request_id, 'waiter');
$$;
create function public.complete_table_tab_bill(p_restaurant_slug text, p_service_request_id uuid)
returns public.service_requests language sql security definer set search_path = '' as $$
  select attendance_private.complete_request(p_restaurant_slug, p_service_request_id, 'bill');
$$;
revoke all on function attendance_private.complete_request(text,uuid,text) from public, anon, authenticated;
revoke all on function public.complete_table_tab_bill(text,uuid) from public, anon, authenticated;
grant execute on function public.complete_table_tab_bill(text,uuid) to authenticated;

-- Quitação conclui o atendimento de conta aceito; solicitação ainda não aceita é cancelada.
-- Não fecha mesa/visita nem altera itens, preparo ou entrega.
create or replace function public.cancel_pending_bill_on_tab_close()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.service_requests set
    status = case when status = 'attended' then 'completed' else 'cancelled' end,
    resolved_at = greatest(clock_timestamp(), new.closed_at, created_at),
    resolved_by_member_id = coalesce(resolved_by_member_id, new.closed_by_member_id)
  where table_tab_id = new.id and restaurant_id = new.restaurant_id
    and table_visit_id = new.table_visit_id and restaurant_table_id = new.restaurant_table_id
    and request_type = 'bill' and status in ('pending', 'attended');
  return new;
end;
$$;

-- Somente recibo de idempotência: a receita continua exclusivamente nos snapshots table_tabs.
create table attendance_private.tab_payments (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  table_visit_id uuid not null references public.table_visits(id),
  member_id uuid not null references public.restaurant_members(id),
  tab_ids uuid[] not null,
  fee_accepted boolean not null,
  preview_token text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table attendance_private.tab_payments enable row level security;
revoke all on attendance_private.tab_payments from public, anon, authenticated;

-- Mesma ordem de locks das operações existentes: restaurante, membro, mesa, visita,
-- comandas e itens. Usado tanto na conferência quanto na confirmação; consulta não grava.
create function attendance_private.payment_selection(
  p_slug text, p_ids uuid[], p_fee boolean, p_allow_closed boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.restaurants%rowtype;
  m public.restaurant_members%rowtype;
  v public.table_visits%rowtype;
  t public.table_tabs%rowtype;
  ids uuid[];
  table_id uuid;
  visit_id uuid;
  tabs jsonb := '[]';
  items jsonb;
  subtotal bigint;
  fee bigint;
  total bigint := 0;
  all_open boolean := true;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception using errcode='42501',message='Entre com uma conta da equipe.';
  end if;
  if p_ids is null or cardinality(p_ids)=0 or array_ndims(p_ids)<>1
    or array_position(p_ids,null) is not null or p_fee is null then
    raise exception using errcode='22023',message='Selecione comandas e a opção de taxa de serviço.';
  end if;
  select array_agg(distinct id order by id) into ids from unnest(p_ids) id;
  if cardinality(ids)<>cardinality(p_ids) then
    raise exception using errcode='22023',message='Seleção de comandas duplicada.';
  end if;
  select * into r from public.restaurants where slug=p_slug and active for share;
  if not found then raise exception using errcode='42501',message='Restaurante indisponível.'; end if;
  select * into m from public.restaurant_members
    where restaurant_id=r.id and user_id=auth.uid() and active and role in ('admin','waiter') for share;
  if not found then raise exception using errcode='42501',message='Sem permissão ativa para este restaurante.'; end if;
  select restaurant_table_id,table_visit_id into table_id,visit_id
    from public.table_tabs where id=ids[1] and restaurant_id=r.id;
  if not found then raise exception using errcode='42501',message='Comandas indisponíveis neste restaurante.'; end if;
  perform id from public.restaurant_tables where id=table_id and restaurant_id=r.id for update;
  select * into v from public.table_visits
    where id=visit_id and restaurant_table_id=table_id and restaurant_id=r.id for update;
  if not found or (m.role<>'admin' and v.assigned_member_id is distinct from m.id) then
    raise exception using errcode='42501',message='Somente o responsável pelo atendimento ou administrador pode quitar estas comandas.';
  end if;
  if (select count(*) from public.table_tabs where id=any(ids) and restaurant_id=r.id
    and restaurant_table_id=table_id and table_visit_id=visit_id)<>cardinality(ids) then
    raise exception using errcode='42501',message='Selecione apenas comandas da mesma mesa e atendimento.';
  end if;
  if not p_allow_closed and v.status<>'open' then
    raise exception using errcode='22023',message='Atendimento já encerrado.';
  end if;
  -- Bloqueia as linhas lidas; novos itens também serializam pela mesa nas RPCs existentes.
  perform id from public.table_tabs where id=any(ids) order by id for update;
  perform id from public.table_tab_items where table_tab_id=any(ids) order by id for update;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) into items
    from public.table_tab_items i where table_tab_id=any(ids);
  for t in select * from public.table_tabs where id=any(ids) order by id loop
    all_open := all_open and t.status='open';
    if not p_allow_closed and t.status<>'open' then
      raise exception using errcode='22023',message='Uma das comandas já foi encerrada. Atualize a seleção.';
    end if;
    select coalesce(sum(line_total_in_cents),0) into subtotal from public.table_tab_items
      where table_tab_id=t.id and restaurant_id=r.id and status='active';
    -- Arredondamento por comanda, igual a close_table_tab: metade para cima em centavos.
    fee := case when p_fee then round(subtotal*r.service_fee_percent/100.0)::bigint else 0 end;
    tabs := tabs || jsonb_build_array(jsonb_build_object('id',t.id,'label',t.label,
      'subtotalInCents',subtotal,'serviceFeeInCents',fee,'totalInCents',subtotal+fee));
    total := total+subtotal+fee;
  end loop;
  return jsonb_build_object('restaurantId',r.id,'tableId',table_id,'visitId',visit_id,'memberId',m.id,
    'tabs',tabs,'totalInCents',total,'allOpen',all_open,'visitOpen',v.status='open',
    'previewToken',md5(jsonb_build_object('restaurantId',r.id,'tableId',table_id,'visitId',visit_id,'tabs',tabs,'items',items,'fee',p_fee,'percent',r.service_fee_percent)::text));
end;
$$;
revoke all on function attendance_private.payment_selection(text,uuid[],boolean,boolean) from public,anon,authenticated;

create function public.preview_table_tabs_payment(p_restaurant_slug text, p_table_tab_ids uuid[], p_service_fee_accepted boolean)
returns jsonb language sql security definer set search_path = '' as $$
  select attendance_private.payment_selection(p_restaurant_slug,p_table_tab_ids,p_service_fee_accepted,false)
    - 'memberId' - 'allOpen' - 'visitOpen';
$$;

create function public.close_table_tabs(
  p_restaurant_slug text, p_table_tab_ids uuid[], p_service_fee_accepted boolean,
  p_payment_id uuid, p_preview_token text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  selection jsonb;
  receipt attendance_private.tab_payments%rowtype;
  ids uuid[];
  tab_id uuid;
  closed public.table_tabs%rowtype;
  result jsonb;
  snapshots jsonb := '[]';
  remaining integer;
begin
  if p_payment_id is null or nullif(p_preview_token,'') is null then
    raise exception using errcode='22023',message='Confira o total antes de confirmar o pagamento.';
  end if;
  selection := attendance_private.payment_selection(p_restaurant_slug,p_table_tab_ids,p_service_fee_accepted,true);
  select array_agg(id order by id) into ids from unnest(p_table_tab_ids) id;
  select * into receipt from attendance_private.tab_payments where id=p_payment_id;
  if found then
    if receipt.restaurant_id<>(selection->>'restaurantId')::uuid or receipt.table_visit_id<>(selection->>'visitId')::uuid
      or receipt.tab_ids<>ids or receipt.fee_accepted<>p_service_fee_accepted or receipt.preview_token<>p_preview_token then
      raise exception using errcode='22023',message='Identificador já utilizado em outra confirmação.';
    end if;
    return receipt.result;
  end if;
  if not (selection->>'allOpen')::boolean or not (selection->>'visitOpen')::boolean then
    raise exception using errcode='22023',message='Uma comanda ou atendimento já foi encerrado. Atualize a seleção.';
  end if;
  if selection->>'previewToken'<>p_preview_token then
    raise exception using errcode='22023',message='Consumo ou taxa mudou. Confira os valores novamente.';
  end if;
  foreach tab_id in array ids loop
    closed := public.close_table_tab(p_restaurant_slug,tab_id,p_service_fee_accepted);
    snapshots := snapshots || jsonb_build_array(to_jsonb(closed));
  end loop;
  select count(*) into remaining from public.table_tabs
    where table_visit_id=(selection->>'visitId')::uuid and status='open';
  result := jsonb_build_object('paymentId',p_payment_id,'tabs',snapshots,
    'totalInCents',(selection->>'totalInCents')::bigint,'openTabsCount',remaining);
  insert into attendance_private.tab_payments(id,restaurant_id,table_visit_id,member_id,tab_ids,fee_accepted,preview_token,result)
    values(p_payment_id,(selection->>'restaurantId')::uuid,(selection->>'visitId')::uuid,
      (selection->>'memberId')::uuid,ids,p_service_fee_accepted,p_preview_token,result);
  -- Encerramento da mesa permanece na RPC existente, com todas as suas validações.
  return result;
end;
$$;
revoke all on function public.preview_table_tabs_payment(text,uuid[],boolean),
  public.close_table_tabs(text,uuid[],boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.preview_table_tabs_payment(text,uuid[],boolean),
  public.close_table_tabs(text,uuid[],boolean,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
