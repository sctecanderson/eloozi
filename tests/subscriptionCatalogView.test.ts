import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrencyBRL,
  resolvePlanCatalogItemView,
  resolveSubscriptionCatalogView,
  type SubscriptionInvoice,
} from '../src/features/billing/billingService.ts';

describe('SubscriptionBillingPage catalog resolution (Etapa 2)', () => {
  it('1. renders prices and table limits from data.catalog different from old hardcoded values', () => {
    const serverCatalog = {
      basic: {
        name: 'Plano Básico',
        monthly_price_cents: 8900, // R$ 89,00 (old hardcoded was R$ 99,90)
        yearly_price_cents: 89000, // R$ 890,00
        max_tables: 10, // (old hardcoded was 5)
        features: ['Até 10 mesas simultâneas', 'Cardápio Digital com QR Code'],
      },
      pro: {
        name: 'Plano Profissional',
        monthly_price_cents: 13900, // R$ 139,00 (old hardcoded was R$ 149,00)
        yearly_price_cents: 139000, // R$ 1.390,00
        max_tables: 25, // (old hardcoded was 15)
        features: ['Até 25 mesas simultâneas', 'KDS Cozinha e Bar'],
      },
      premium: {
        name: 'Plano Premium Enterprise',
        monthly_price_cents: 19900, // R$ 199,00 (old hardcoded was R$ 230,00)
        yearly_price_cents: 199000, // R$ 1.990,00
        max_tables: 60, // (old hardcoded was 100, and features had contradictory text)
        features: ['Mesas ilimitadas (até 60)', 'Tudo do Profissional'],
      },
    };

    const monthlyView = resolveSubscriptionCatalogView(serverCatalog, 'monthly');

    assert.equal(monthlyView.hasAnyInvalidPlan, false);
    assert.equal(monthlyView.globalWarningMessage, null);

    // Monthly prices match server catalog, not old hardcoded strings
    assert.equal(monthlyView.plans.basic.primaryPriceLabel, formatCurrencyBRL(8900));
    assert.equal(monthlyView.plans.basic.primaryPeriodSuffix, '/mês');
    assert.equal(monthlyView.plans.pro.primaryPriceLabel, formatCurrencyBRL(13900));
    assert.equal(monthlyView.plans.premium.primaryPriceLabel, formatCurrencyBRL(19900));

    // Table quotas come strictly from max_tables, ignoring contradictory features string
    assert.equal(monthlyView.plans.basic.tablesBenefitLabel, 'Até 10 mesas simultâneas');
    assert.equal(monthlyView.plans.pro.tablesBenefitLabel, 'Até 25 mesas simultâneas');
    assert.equal(monthlyView.plans.premium.tablesBenefitLabel, 'Até 60 mesas simultâneas');
    assert.ok(!monthlyView.plans.premium.tablesBenefitLabel.toLowerCase().includes('ilimitad'));

    // Comparison table row labels also match max_tables
    assert.equal(monthlyView.plans.basic.comparisonTablesLabel, 'Até 10 mesas');
    assert.equal(monthlyView.plans.pro.comparisonTablesLabel, 'Até 25 mesas');
    assert.equal(monthlyView.plans.premium.comparisonTablesLabel, 'Até 60 mesas');
  });

  it('2. calculates annual total, monthly equivalent, and only shows savings badge when sustained by values', () => {
    const discountedCatalog = {
      basic: {
        name: 'Plano Básico',
        monthly_price_cents: 9900,
        yearly_price_cents: 99000, // 10x monthly -> 2 free months equivalent
        max_tables: 10,
        features: [],
      },
      pro: {
        name: 'Plano Profissional',
        monthly_price_cents: 14900,
        yearly_price_cents: 149000, // 10x monthly -> 2 free months equivalent
        max_tables: 25,
        features: [],
      },
      premium: {
        name: 'Plano Premium',
        monthly_price_cents: 19900,
        yearly_price_cents: 199000, // 10x monthly -> 2 free months equivalent
        max_tables: 60,
        features: [],
      },
    };

    const yearlyView = resolveSubscriptionCatalogView(discountedCatalog, 'yearly');

    // Equivalent monthly is yearly_price_cents / 12 (199000 / 12 = 16583 cents = R$ 165,83)
    assert.equal(yearlyView.plans.premium.yearlyMonthlyEquivalentCents, 16583);
    assert.equal(yearlyView.plans.premium.primaryPriceLabel, formatCurrencyBRL(16583));
    assert.equal(yearlyView.plans.premium.primaryPeriodSuffix, '/mês (equivalente)');
    assert.equal(
      yearlyView.plans.premium.secondaryBillingLabel,
      `Total cobrado no ano: ${formatCurrencyBRL(199000)}`,
    );

    // Savings badge is sustained (10x vs 12x = 2 months free)
    assert.equal(yearlyView.yearlyToggleBadgeLabel, '2 MESES GRÁTIS');

    // Now test a catalog where annual has NO discount (yearly = 12 * monthly)
    const noDiscountCatalog = {
      basic: {
        name: 'Plano Básico',
        monthly_price_cents: 10000,
        yearly_price_cents: 120000,
        max_tables: 10,
        features: [],
      },
      pro: {
        name: 'Plano Profissional',
        monthly_price_cents: 15000,
        yearly_price_cents: 180000,
        max_tables: 25,
        features: [],
      },
      premium: {
        name: 'Plano Premium',
        monthly_price_cents: 20000,
        yearly_price_cents: 240000,
        max_tables: 60,
        features: [],
      },
    };

    const noDiscountYearlyView = resolveSubscriptionCatalogView(noDiscountCatalog, 'yearly');
    assert.equal(noDiscountYearlyView.yearlyToggleBadgeLabel, null);
    assert.equal(noDiscountYearlyView.plans.basic.yearlySavingsCents, 0);
    assert.equal(noDiscountYearlyView.plans.basic.yearlySavingsBadgeLabel, null);
  });

  it('3. blocks checkout for plans with missing or invalid catalog fields without using fixed fallbacks or treating 0 price as missing', () => {
    // Missing premium plan and invalid max_tables in pro, while basic has price 0 (valid free tier)
    const partialCatalog = {
      basic: {
        name: 'Plano Básico Promocional',
        monthly_price_cents: 0,
        yearly_price_cents: 0,
        max_tables: 8,
        features: [],
      },
      pro: {
        name: 'Plano Profissional',
        monthly_price_cents: 14900,
        yearly_price_cents: 149000,
        max_tables: null as unknown as number, // missing max_tables must NOT become unlimited
        features: [],
      },
      premium: undefined,
    };

    const view = resolveSubscriptionCatalogView(partialCatalog, 'monthly');

    // Basic with price 0 is valid and allowed to checkout
    assert.equal(view.plans.basic.valid, true);
    assert.equal(view.plans.basic.canCheckout, true);
    assert.equal(view.plans.basic.primaryPriceLabel, formatCurrencyBRL(0));
    assert.equal(view.plans.basic.tablesBenefitLabel, 'Até 8 mesas simultâneas');

    // Pro has missing max_tables -> invalid, blocks checkout, does NOT say unlimited
    assert.equal(view.plans.pro.valid, false);
    assert.equal(view.plans.pro.canCheckout, false);
    assert.equal(view.plans.pro.tablesBenefitLabel, 'Limite de mesas indisponível no catálogo');
    assert.equal(view.plans.pro.comparisonTablesLabel, 'Indisponível');

    // Premium is missing -> invalid, blocks checkout, no R$ 230 or 100 tables fallback
    assert.equal(view.plans.premium.valid, false);
    assert.equal(view.plans.premium.canCheckout, false);
    assert.equal(view.plans.premium.primaryPriceLabel, 'Indisponível');

    // Global warning is populated
    assert.equal(view.hasAnyInvalidPlan, true);
    assert.ok(view.globalWarningMessage?.includes('bloqueados para contratação'));

    // When yearly_price_cents is missing, the plan catalog is incomplete -> valid=false and canCheckout=false in both cycles
    const missingYearlyItemInMonthlyCycle = resolvePlanCatalogItemView(
      'pro',
      {
        name: 'Plano Profissional',
        monthly_price_cents: 14900,
        yearly_price_cents: null as unknown as number,
        max_tables: 25,
      },
      'monthly',
    );
    assert.equal(missingYearlyItemInMonthlyCycle.valid, false);
    assert.equal(missingYearlyItemInMonthlyCycle.canCheckout, false);
    assert.ok(missingYearlyItemInMonthlyCycle.validationMessage?.includes('bloqueada'));

    const missingYearlyItemInYearlyCycle = resolvePlanCatalogItemView(
      'pro',
      {
        name: 'Plano Profissional',
        monthly_price_cents: 14900,
        yearly_price_cents: null as unknown as number,
        max_tables: 25,
      },
      'yearly',
    );
    assert.equal(missingYearlyItemInYearlyCycle.valid, false);
    assert.equal(missingYearlyItemInYearlyCycle.canCheckout, false);
    assert.equal(missingYearlyItemInYearlyCycle.primaryPriceLabel, 'Indisponível');

    // Inverse case: when monthly_price_cents is missing, yearly cycle also has valid=false and canCheckout=false
    const missingMonthlyItemInYearlyCycle = resolvePlanCatalogItemView(
      'pro',
      {
        name: 'Plano Profissional',
        monthly_price_cents: null as unknown as number,
        yearly_price_cents: 149000,
        max_tables: 25,
      },
      'yearly',
    );
    assert.equal(missingMonthlyItemInYearlyCycle.valid, false);
    assert.equal(missingMonthlyItemInYearlyCycle.canCheckout, false);
    assert.ok(missingMonthlyItemInYearlyCycle.validationMessage?.includes('bloqueada'));

    const missingMonthlyItemInMonthlyCycle = resolvePlanCatalogItemView(
      'pro',
      {
        name: 'Plano Profissional',
        monthly_price_cents: null as unknown as number,
        yearly_price_cents: 149000,
        max_tables: 25,
      },
      'monthly',
    );
    assert.equal(missingMonthlyItemInMonthlyCycle.valid, false);
    assert.equal(missingMonthlyItemInMonthlyCycle.canCheckout, false);
    assert.equal(missingMonthlyItemInMonthlyCycle.primaryPriceLabel, 'Indisponível');
  });

  it('4. preserves historical invoice amount_cents independent of current catalog prices', () => {
    const historicalInvoices: SubscriptionInvoice[] = [
      {
        id: 'inv-old-1',
        plan_id: 'premium',
        billing_cycle: 'monthly',
        amount_cents: 23000, // Historical invoice charged at R$ 230,00
        payment_method: 'pix',
        status: 'paid',
        pix_qr_code_payload: null,
        pix_expires_at: null,
        card_brand: null,
        card_last4: null,
        external_reference: 'pay_old_1',
        paid_at: '2026-09-01T12:00:00Z',
        created_at: '2026-09-01T11:55:00Z',
      },
      {
        id: 'inv-new-2',
        plan_id: 'premium',
        billing_cycle: 'monthly',
        amount_cents: 19900, // Newer invoice charged at R$ 199,00
        payment_method: 'credit_card',
        status: 'paid',
        pix_qr_code_payload: null,
        pix_expires_at: null,
        card_brand: 'visa',
        card_last4: '4242',
        external_reference: 'pay_new_2',
        paid_at: '2026-10-01T12:00:00Z',
        created_at: '2026-10-01T12:00:00Z',
      },
    ];

    const currentCatalog = {
      basic: { name: 'Básico', monthly_price_cents: 9900, yearly_price_cents: 99000, max_tables: 10, features: [] },
      pro: { name: 'Pro', monthly_price_cents: 14900, yearly_price_cents: 149000, max_tables: 25, features: [] },
      premium: { name: 'Premium', monthly_price_cents: 19900, yearly_price_cents: 199000, max_tables: 60, features: [] },
    };

    const catalogView = resolveSubscriptionCatalogView(currentCatalog, 'monthly');
    assert.equal(catalogView.plans.premium.primaryPriceLabel, formatCurrencyBRL(19900));

    // Historical invoice formatting uses inv.amount_cents directly and is never overwritten by catalogView
    assert.equal(formatCurrencyBRL(historicalInvoices[0].amount_cents), formatCurrencyBRL(23000));
    assert.equal(formatCurrencyBRL(historicalInvoices[1].amount_cents), formatCurrencyBRL(19900));
    assert.notEqual(
      formatCurrencyBRL(historicalInvoices[0].amount_cents),
      catalogView.plans.premium.primaryPriceLabel,
    );
  });

  it('5. resolves the approved Etapa 3 commercial catalog (99,90 / 179,90 / 279,90, 11x annual, 5 / 20 / explicit unlimited tables)', () => {
    const etapa3Catalog = {
      basic: {
        name: 'Plano Básico',
        monthly_price_cents: 9990,
        yearly_price_cents: 109890, // 9990 * 11
        max_tables: 5,
        unlimited_tables: false,
        features: [
          'Até 5 mesas simultâneas',
          'Cardápio digital com QR Code',
          'Pedidos, mesas e comandas',
        ],
      },
      pro: {
        name: 'Plano Profissional',
        monthly_price_cents: 17990,
        yearly_price_cents: 197890, // 17990 * 11
        max_tables: 20,
        unlimited_tables: false,
        features: [
          'Até 20 mesas simultâneas',
          'Tudo do plano Básico',
          'KDS cozinha/bar em tempo real',
        ],
      },
      premium: {
        name: 'Plano Premium',
        monthly_price_cents: 27990,
        yearly_price_cents: 307890, // 27990 * 11
        max_tables: null,
        unlimited_tables: true,
        features: [
          'Mesas simultâneas ilimitadas',
          'Tudo do plano Profissional',
          'Estoque e insumos com alerta de mínimo',
          'Financeiro e fechamento de caixa',
        ],
      },
    };

    const monthlyView = resolveSubscriptionCatalogView(etapa3Catalog, 'monthly');
    assert.equal(monthlyView.hasAnyInvalidPlan, false);
    assert.equal(monthlyView.globalWarningMessage, null);

    // Monthly prices
    assert.equal(monthlyView.plans.basic.primaryPriceLabel, formatCurrencyBRL(9990));
    assert.equal(monthlyView.plans.pro.primaryPriceLabel, formatCurrencyBRL(17990));
    assert.equal(monthlyView.plans.premium.primaryPriceLabel, formatCurrencyBRL(27990));

    // Table capacities: 5, 20, and explicit unlimited
    assert.equal(monthlyView.plans.basic.unlimitedTables, false);
    assert.equal(monthlyView.plans.basic.maxTables, 5);
    assert.equal(monthlyView.plans.basic.tablesBenefitLabel, 'Até 5 mesas simultâneas');
    assert.equal(monthlyView.plans.basic.comparisonTablesLabel, 'Até 5 mesas');

    assert.equal(monthlyView.plans.pro.unlimitedTables, false);
    assert.equal(monthlyView.plans.pro.maxTables, 20);
    assert.equal(monthlyView.plans.pro.tablesBenefitLabel, 'Até 20 mesas simultâneas');
    assert.equal(monthlyView.plans.pro.comparisonTablesLabel, 'Até 20 mesas');

    assert.equal(monthlyView.plans.premium.unlimitedTables, true);
    assert.equal(monthlyView.plans.premium.maxTables, null);
    assert.equal(monthlyView.plans.premium.tablesBenefitLabel, 'Mesas simultâneas ilimitadas');
    assert.equal(monthlyView.plans.premium.comparisonTablesLabel, 'Ilimitadas');

    // Yearly cycle: 11x monthly -> 1 month free across all 3 plans
    const yearlyView = resolveSubscriptionCatalogView(etapa3Catalog, 'yearly');
    assert.equal(yearlyView.yearlyToggleBadgeLabel, '1 MÊS GRÁTIS');

    assert.equal(
      yearlyView.plans.basic.secondaryBillingLabel,
      `Total cobrado no ano: ${formatCurrencyBRL(109890)}`,
    );
    assert.equal(yearlyView.plans.basic.yearlySavingsBadgeLabel, '1 MÊS GRÁTIS');

    assert.equal(
      yearlyView.plans.pro.secondaryBillingLabel,
      `Total cobrado no ano: ${formatCurrencyBRL(197890)}`,
    );
    assert.equal(yearlyView.plans.pro.yearlySavingsBadgeLabel, '1 MÊS GRÁTIS');

    assert.equal(
      yearlyView.plans.premium.secondaryBillingLabel,
      `Total cobrado no ano: ${formatCurrencyBRL(307890)}`,
    );
    assert.equal(yearlyView.plans.premium.yearlySavingsBadgeLabel, '1 MÊS GRÁTIS');

    // Verify that unlimited_tables: true with a numeric max_tables is rejected as contradictory/invalid
    const contradictoryUnlimited = resolvePlanCatalogItemView(
      'premium',
      {
        name: 'Premium Contraditório',
        monthly_price_cents: 27990,
        yearly_price_cents: 307890,
        max_tables: 100,
        unlimited_tables: true,
      },
      'monthly',
    );
    assert.equal(contradictoryUnlimited.valid, false);
    assert.equal(contradictoryUnlimited.canCheckout, false);
  });
});
