begin;

-- Remoção de colaboradores da equipe com preservação de histórico.
-- 1. Bloqueia a remoção caso o colaborador possua atendimentos abertos (table_visits.status = 'open').
-- 2. Impede a remoção se for o último administrador ativo do restaurante.
-- 3. Revoga convites pendentes gerados por esse colaborador.
-- 4. Exclui os dados cadastrais complementares em staff_profiles para este restaurante.
-- 5. Se o colaborador NÃO possuir registros operacionais anteriores (comandas, pedidos, visitas, chamados),
--    remove fisicamente o vínculo em restaurant_members.
-- 6. Se o colaborador POSSUIR registros operacionais anteriores, desativa o vínculo (active = false),
--    preservando integralmente a integridade referencial, histórico de comandas e auditoria, sem apagar auth.users.

create or replace function public.remove_staff_member(p_slug text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  rid uuid;
  member public.restaurant_members%rowtype;
  member_user_email text;
  has_history boolean := false;
begin
  rid := public.lock_staff_management(p_slug);

  if p_id is null then
    raise exception using errcode = '22023', message = 'Identificador do funcionário inválido.';
  end if;

  select * into member
  from public.restaurant_members
  where id = p_id and restaurant_id = rid
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Funcionário não encontrado neste restaurante.';
  end if;

  -- 1. Impede remover o último administrador ativo
  if member.active and member.role = 'admin' and not exists(
    select 1 from public.restaurant_members
    where restaurant_id = rid and id <> member.id and active and role = 'admin'
  ) then
    raise exception using errcode = '55000', message = 'Mantenha pelo menos um administrador ativo.';
  end if;

  -- 2. Bloqueia se houver atendimentos abertos
  if exists(select 1 from public.table_visits where assigned_member_id = member.id and status = 'open') then
    raise exception using errcode = '55000', message = 'Transfira os atendimentos abertos deste funcionário antes de removê-lo da equipe.';
  end if;

  -- 3. Localiza e-mail do usuário para limpeza de convites e perfil
  select lower(email) into member_user_email
  from auth.users
  where id = member.user_id;

  -- 4. Revoga convites pendentes criados por ele
  update public.staff_invitations
  set status = 'revoked'
  where source_restaurant_id = rid and created_by = member.user_id and status = 'pending';

  -- 5. Remove perfil complementar da equipe do restaurante
  if member_user_email is not null then
    delete from public.staff_profiles
    where restaurant_id = rid and email = member_user_email;
  end if;

  -- 6. Verifica se há dependências em tabelas de auditoria e comanda com restrição
  has_history := exists(select 1 from public.table_visits where assigned_member_id = member.id)
    or exists(select 1 from public.table_tabs where created_by_member_id = member.id or closed_by_member_id = member.id)
    or exists(select 1 from public.table_tab_items where added_by_member_id = member.id or cancelled_by_member_id = member.id)
    or exists(select 1 from public.service_requests where resolved_by_member_id = member.id)
    or exists(select 1 from public.guest_sessions where confirmed_by_member_id = member.id);

  if not has_history then
    -- Sem histórico: limpa limites de confirmação e exclui o vínculo de restaurant_members
    delete from public.staff_confirmation_limits where member_id = member.id;
    delete from public.restaurant_members where id = member.id;
  else
    -- Com histórico: desativa o acesso (active = false) preservando quem abriu/fechou comandas e itens
    update public.restaurant_members set active = false where id = member.id;
  end if;
end; $$;

revoke all on function public.remove_staff_member(text, uuid) from public, anon, authenticated;
grant execute on function public.remove_staff_member(text, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
