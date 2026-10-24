begin;

-- ============================================================================
-- 1. NOVAS COLUNAS dashboard_logo_url E dashboard_banner_url EM public.restaurants
-- Permite desacoplar as imagens do Painel Administrativo da Identidade Visual do Cardápio
-- ============================================================================
alter table public.restaurants
  add column if not exists dashboard_logo_url text,
  add column if not exists dashboard_banner_url text;

-- ============================================================================
-- 2. ATUALIZAR get_public_restaurant COM dashboard_logo_url E dashboard_banner_url
-- ============================================================================
create or replace function public.get_public_restaurant(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'slug', r.slug,
    'name', r.name,
    'subtitle', coalesce(r.subtitle, ''),
    'logo', r.logo,
    'cover', r.cover,
    'dashboard_logo_url', r.dashboard_logo_url,
    'dashboard_banner_url', r.dashboard_banner_url,
    'dashboardLogoUrl', r.dashboard_logo_url,
    'dashboardBannerUrl', r.dashboard_banner_url,
    'theme', jsonb_build_object(
      'primary', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
      'background', r.theme_background,
      'text', r.theme_text
    ),
    'brandPrimaryColor', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
    'brand_primary_color', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
    'headerNameColor', coalesce(r.header_name_color, '#1c1917'),
    'header_name_color', coalesce(r.header_name_color, '#1c1917'),
    'headerSubtitleColor', coalesce(r.header_subtitle_color, '#57534e'),
    'header_subtitle_color', coalesce(r.header_subtitle_color, '#57534e'),
    'menuTheme', coalesce(r.menu_theme, 'classic'),
    'menu_theme', coalesce(r.menu_theme, 'classic'),
    'description', r.description,
    'address', r.address,
    'phone', r.phone,
    'openingHours', r.opening_hours,
    'revision', r.revision,
    'serviceFeePercent', r.service_fee_percent,
    'timezone', r.timezone,
    'googleReviewUrl', r.google_review_url,
    'subscriptionPlan', r.subscription_plan,
    'subscription_plan', r.subscription_plan,
    'maxTables', coalesce(r.max_tables, 10),
    'max_tables', coalesce(r.max_tables, 10),
    'subscriptionExpiresAt', r.subscription_expires_at,
    'subscription_expires_at', r.subscription_expires_at,
    'billingStatus', public.get_restaurant_billing_status(r.subscription_expires_at),
    'billing_status', public.get_restaurant_billing_status(r.subscription_expires_at)
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

-- ============================================================================
-- 3. RPC save_dashboard_media PARA O ADMIN SALVAR AS IMAGENS DO PAINEL
-- ============================================================================
create or replace function public.save_dashboard_media(
  p_restaurant_id uuid,
  p_dashboard_logo_url text default null,
  p_dashboard_banner_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated record;
begin
  if not (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = (select auth.uid())
        and m.active = true
        and m.role = 'admin'
    )
  ) then
    raise exception 'Acesso não autorizado para alterar mídia do painel administrativo.' using errcode = '42501';
  end if;

  update public.restaurants
  set
    dashboard_logo_url = case when p_dashboard_logo_url is not null then p_dashboard_logo_url else dashboard_logo_url end,
    dashboard_banner_url = case when p_dashboard_banner_url is not null then p_dashboard_banner_url else dashboard_banner_url end
  where id = p_restaurant_id
  returning id, dashboard_logo_url, dashboard_banner_url into v_updated;

  return jsonb_build_object(
    'id', v_updated.id,
    'dashboard_logo_url', v_updated.dashboard_logo_url,
    'dashboard_banner_url', v_updated.dashboard_banner_url
  );
end;
$$;

revoke all on function public.save_dashboard_media(uuid, text, text) from public, anon, authenticated;
grant execute on function public.save_dashboard_media(uuid, text, text) to authenticated;

commit;
