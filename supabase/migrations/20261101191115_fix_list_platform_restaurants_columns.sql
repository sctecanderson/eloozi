-- Migration: 20261101190000_fix_list_platform_restaurants_columns.sql
-- Descrição: Corrige public.list_platform_restaurants() removendo colunas inexistentes
-- (restaurant.logo_url, restaurant.cover_url, restaurant.updated_at) e enxugando o JSON
-- retornado para conter estritamente os campos consumidos pelo frontend PlatformRestaurant.
-- Preserva SECURITY DEFINER, search_path vazio, checagem de platform_admins e grants.

create or replace function public.list_platform_restaurants()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_admin boolean;
begin
  select exists (
    select 1
    from public.platform_admins as admin
    where admin.user_id = auth.uid()
      and admin.active = true
  )
  into is_admin;

  if not is_admin then
    raise exception using
      errcode = '42501',
      message = 'Apenas administradores da plataforma podem listar todos os restaurantes.';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', restaurant.id,
          'name', restaurant.name,
          'slug', restaurant.slug,
          'active', restaurant.active,
          'archivedAt', restaurant.archived_at,
          'createdAt', restaurant.created_at,
          'adminCount', (
            select count(*)::integer
            from public.restaurant_members as member
            where member.restaurant_id = restaurant.id
              and member.role = 'admin'
              and member.active = true
          ),
          'adminEmails', coalesce(
            (
              select jsonb_agg(u.email)
              from public.restaurant_members as member
              join auth.users as u on u.id = member.user_id
              where member.restaurant_id = restaurant.id
                and member.role = 'admin'
                and member.active = true
                and u.email is not null
            ),
            '[]'::jsonb
          ),
          'subscriptionPlan', coalesce(restaurant.subscription_plan, 'basic'),
          'monthlyPriceCents', coalesce(restaurant.monthly_price_cents, 9990),
          'unlimitedTables', coalesce(restaurant.unlimited_tables, false),
          'maxTables', case when coalesce(restaurant.unlimited_tables, false) then null else coalesce(restaurant.max_tables, 5) end,
          'activeTablesCount', (
            select count(*)::integer
            from public.restaurant_tables as t
            where t.restaurant_id = restaurant.id
              and t.deleted_at is null
              and (t.active = true or t.is_active = true)
          ),
          'subscriptionStartedAt', restaurant.subscription_started_at,
          'subscriptionExpiresAt', restaurant.subscription_expires_at,
          'billingCycleDays', coalesce(restaurant.billing_cycle_days, 30),
          'daysRemaining', ceil(extract(epoch from (restaurant.subscription_expires_at - now())) / 86400.0)::int,
          'billingStatus', public.get_restaurant_billing_status(restaurant.subscription_expires_at, restaurant.subscription_is_trial)
        )
        order by restaurant.created_at desc, restaurant.id
      )
      from public.restaurants as restaurant
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.list_platform_restaurants() from public, anon;
grant execute on function public.list_platform_restaurants() to authenticated;
grant execute on function public.list_platform_restaurants() to service_role;
