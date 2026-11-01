begin;

-- ============================================================================
-- ELOOZI — ETAPA 1: VERSIONAR A CORREÇÃO DO RESUMO DE FATURAMENTO
-- ============================================================================
-- Corrige public.get_restaurant_billing_summary(uuid) para consultar apenas
-- as colunas reais existentes em public.subscription_invoices, preservando
-- o contrato JSON com o frontend (billingService.ts e SubscriptionBillingPage.tsx),
-- as regras de autorização, o catálogo, o trial, o vencimento, as contagens,
-- os métodos de pagamento, o limite de histórico e os grants existentes.
-- ============================================================================

create or replace function public.get_restaurant_billing_summary(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant record;
  v_settings record;
  v_tables_count integer;
  v_products_count integer;
  v_invoices jsonb;
  v_methods jsonb;
begin
  if not (
    public.is_platform_admin() or
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
        and m.active = true
    )
  ) then
    raise exception 'Apenas administradores do restaurante ou da plataforma podem consultar o faturamento.'
      using errcode = '42501';
  end if;

  select * into v_restaurant
  from public.restaurants
  where id = p_restaurant_id;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = 'P0002';
  end if;

  select * into v_settings from public.platform_settings where id = 'default';
  if not found then
    raise exception 'Configurações de catálogo de planos (platform_settings id=default) não encontradas.'
      using errcode = 'P0002';
  end if;

  select count(*) into v_tables_count
  from public.restaurant_tables
  where restaurant_id = p_restaurant_id and deleted_at is null and coalesce(is_active, active, true) = true;

  select count(*) into v_products_count
  from public.menu_products
  where restaurant_id = p_restaurant_id and available = true;

  select coalesce(jsonb_agg(inv_row), '[]'::jsonb)
  into v_invoices
  from (
    select
      i.id,
      i.plan_id,
      i.billing_cycle,
      i.amount_cents,
      i.payment_method,
      i.status,
      i.pix_qr_code_payload,
      i.pix_expires_at,
      i.card_brand,
      i.card_last4,
      i.external_reference,
      i.paid_at,
      i.created_at
    from public.subscription_invoices as i
    where i.restaurant_id = p_restaurant_id
    order by i.created_at desc
    limit 24
  ) as inv_row;

  select coalesce(jsonb_agg(pm_row), '[]'::jsonb)
  into v_methods
  from (
    select
      pm.id,
      pm.method_type,
      pm.holder_name,
      pm.card_brand,
      pm.card_last4,
      pm.exp_month,
      pm.exp_year,
      pm.is_default,
      pm.created_at
    from public.restaurant_payment_methods as pm
    where pm.restaurant_id = p_restaurant_id
    order by pm.created_at desc
  ) as pm_row;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id,
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'subscription_plan', v_restaurant.subscription_plan,
      'subscription_started_at', v_restaurant.subscription_started_at,
      'subscription_expires_at', v_restaurant.subscription_expires_at,
      'billing_cycle_days', v_restaurant.billing_cycle_days,
      'max_tables', v_restaurant.max_tables,
      'monthly_price_cents', v_restaurant.monthly_price_cents,
      'active', v_restaurant.active,
      'subscription_is_trial', coalesce(v_restaurant.subscription_is_trial, false),
      'billing_status', public.get_restaurant_billing_status(v_restaurant.subscription_expires_at, v_restaurant.subscription_is_trial),
      'days_remaining', ceil(extract(epoch from (v_restaurant.subscription_expires_at - now())) / 86400.0)::int
    ),
    'usage', jsonb_build_object(
      'tables_count', v_tables_count,
      'products_count', v_products_count
    ),
    'catalog', jsonb_build_object(
      'basic', jsonb_build_object(
        'plan_id', 'basic',
        'name', 'Plano Básico',
        'monthly_price_cents', v_settings.basic_price_cents,
        'yearly_price_cents', v_settings.basic_price_cents * 10,
        'max_tables', v_settings.basic_max_tables,
        'features', jsonb_build_array('Cardápio Digital com QR Code', 'Pedidos em tempo real nas mesas', 'Até 10 mesas simultâneas', 'Suporte padrão via e-mail')
      ),
      'pro', jsonb_build_object(
        'plan_id', 'pro',
        'name', 'Plano Profissional',
        'monthly_price_cents', v_settings.pro_price_cents,
        'yearly_price_cents', v_settings.pro_price_cents * 10,
        'max_tables', v_settings.pro_max_tables,
        'features', jsonb_build_array('Tudo do Básico', 'KDS Completo (Cozinha e Bar)', 'Gestão de Estoque e Insumos', 'Até 25 mesas simultâneas', 'Alertas sonoros para garçons')
      ),
      'premium', jsonb_build_object(
        'plan_id', 'premium',
        'name', 'Plano Premium Executivo',
        'monthly_price_cents', v_settings.premium_price_cents,
        'yearly_price_cents', v_settings.premium_price_cents * 10,
        'max_tables', v_settings.premium_max_tables,
        'features', jsonb_build_array('Tudo do Profissional', 'Painel Executivo Multi-filiais', 'Exportações Contábeis e DRE', 'Mesas ilimitadas (até 60)', 'Gerente de Contas Dedicado')
      )
    ),
    'invoices', v_invoices,
    'payment_methods', v_methods
  );
end;
$$;

revoke all on function public.get_restaurant_billing_summary(uuid) from public, anon;
grant execute on function public.get_restaurant_billing_summary(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
