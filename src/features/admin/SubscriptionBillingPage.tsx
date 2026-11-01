import {readScheduledChange,changeScheduledDowngrade,isLowerPlan,type ScheduledChangeState} from '../billing/scheduledDowngrade';
import {ScheduledDowngradePanel} from '../billing/ScheduledDowngradePanel';
import { useEffect, useRef, useState, useTransition } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {PlanBanner,SubscriptionPlanCards,CheckoutShell,BillingIcon,ContractTitle,ContractResourceIcon} from '../billing/SubscriptionDesign';
import {visibleContractPlan,checkoutPeriodLabel,contractDetailResources} from '../billing/subscriptionPresentation';
import '../billing/current-contract-card.css';
import {PremiumTrialNote} from '../billing/TrialBanner';
import {CheckoutFinancialSummary} from '../billing/CheckoutFinancialSummary';

import { supabase } from '../../lib/supabase';
import { TermsOfUseModal } from '../../components/TermsOfUseModal';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import {
  fetchBillingSummary,
  createSubscriptionCheckout,
  confirmSubscriptionInvoice,
  deleteSavedPaymentMethod,
  formatCurrencyBRL,
  detectCardBrand,
  resolveSubscriptionCatalogView,
  type BillingSummaryResponse,
  type SubscriptionPlanId,
  type BillingCycle,
  type PaymentMethodType,
  type SubscriptionInvoice,
  type SavedPaymentMethod,
} from '../billing/billingService';

function formatCpfCnpj(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 14);
  if (digits.length <= 11) {
    return digits
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

function formatCep(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 8);
  return digits.replace(/(\d{5})(\d{1,3})/, '$1-$2');
}

const PLAN_TITLES: Record<SubscriptionPlanId, string> = {
  basic: 'Plano Básico',
  pro: 'Plano Profissional',
  premium: 'Plano Premium',
};

export function SubscriptionBillingPage() {
  const { restaurant: r, reload } = useRestaurant();
  const currentDetails = useRef<HTMLDetailsElement>(null);
  const [currentDetailsOpen,setCurrentDetailsOpen]=useState(false);
  const [data, setData] = useState<BillingSummaryResponse | null>(null);
  const [planChange,setPlanChange]=useState<ScheduledChangeState|null>(null);
  const [downgradeDraft,setDowngradeDraft]=useState<SubscriptionPlanId|null>(null);
  const [changeBusy,setChangeBusy]=useState(false);
  const [changeError,setChangeError]=useState<string|null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [, startTransition] = useTransition();

  // Modal de Checkout / Renovação
  const [checkoutModal, setCheckoutModal] = useState<{
    open: boolean;
    planId: SubscriptionPlanId;
    cycle: BillingCycle;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<PaymentMethodType>('pix');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [pixPending, setPixPending] = useState<{
    invoiceId: string;
    payload: string;
    expiresAt: string;
    amountCents: number;
    planId: SubscriptionPlanId;
    image?: string;
  } | null>(null);
  const [copiedPix, setCopiedPix] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [checkoutSuccess, setCheckoutSuccess] = useState<{
    invoiceId: string;
    planId: SubscriptionPlanId;
    expiresAt: string;
    maxTables: number | null;
    unlimitedTables: boolean;
  } | null>(null);

  // Modal de Comprovante / Recibo
  const [receiptInvoice, setReceiptInvoice] = useState<SubscriptionInvoice | null>(null);

  // Modal de Adicionar Novo Cartão
  const [addCardModalOpen, setAddCardModalOpen] = useState(false);
  const [addCardBusy, setAddCardBusy] = useState(false);
  const [activeCardMenuId, setActiveCardMenuId] = useState<string | null>(null);
  const cardMenuRef = useRef<HTMLDivElement>(null);

  // Dados do Pagador (Obrigatório Asaas)
  const [payerCpfCnpj, setPayerCpfCnpj] = useState('');
  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [payerPostalCode, setPayerPostalCode] = useState('');
  const [payerAddressNumber, setPayerAddressNumber] = useState('');

  // Formulário de Cartão
  const [cardNumber, setCardNumber] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardExp, setCardExp] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [saveCard, setSaveCard] = useState(true);
  const [selectedSavedCardId, setSelectedSavedCardId] = useState<string>('new');
  const [isDefaultNewCard, setIsDefaultNewCard] = useState(true);
  const [termsModalOpen, setTermsModalOpen] = useState<boolean>(false);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [res,scheduled] = await Promise.all([fetchBillingSummary(r.id),readScheduledChange(r.id)]);
      setData(res);setPlanChange(scheduled);
      void reload().catch(() => { /* Provider retries its read refresh. */ });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao buscar dados de faturamento.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [r.id]);

  useEffect(()=>{if(downgradeDraft){const panel=document.getElementById('scheduled-downgrade');panel?.scrollIntoView({behavior:'smooth',block:'center'});panel?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});}},[downgradeDraft]);

  // Fechar menu de cartão ao clicar fora
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (cardMenuRef.current && !cardMenuRef.current.contains(e.target as Node)) {
        setActiveCardMenuId(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const [scheduledRenewalToken,setScheduledRenewalToken]=useState<string|undefined>(undefined);
  const [transitionQuote, setTransitionQuote] = useState<{quote_token:string;full_amount_cents:number;credit_cents:number;amount_to_charge_cents:number;effective_at:string;expires_at:string}|null>(null);
  const saveDowngrade = async (target:SubscriptionPlanId|null) => {
    setChangeBusy(true);setChangeError(null);try{const saved=await changeScheduledDowngrade(r.id,target);setPlanChange(saved);setDowngradeDraft(null);await loadData();}catch(err){setChangeError(err instanceof Error?err.message:'Falha ao salvar agendamento.');try{setPlanChange(await readScheduledChange(r.id));}catch{/* Preserve last confirmed state; error stays visible. */}}finally{setChangeBusy(false);}
  };
  const handleOpenCheckout = async (planId: SubscriptionPlanId, selectedCycle: BillingCycle, scheduledRenewal=false) => {
    if(!scheduledRenewal&&isLowerPlan(planId,planChange?.current_plan)){setDowngradeDraft(planId);setChangeError(null);return;}
    if(scheduledRenewal&&!planChange?.can_renew){setChangeError('A renovação estará disponível a partir da data agendada.');return;}
    const checkCatalog = resolveSubscriptionCatalogView(data?.catalog, selectedCycle);
    const planCheck = checkCatalog.plans[planId];
    if (!planCheck.canCheckout) {
      setFeedback({
        type: 'error',
        message:
          planCheck.validationMessage ||
          'Os dados deste plano no catálogo estão incompletos. Não é possível iniciar o checkout.',
      });
      return;
    }

    setScheduledRenewalToken(scheduledRenewal&&planChange?.scheduled_change?'scheduled-downgrade:'+planChange.scheduled_change.id:undefined);
    setTransitionQuote(null);
    if (!scheduledRenewal && r.effectiveSubscription?.known_trial && r.effectiveSubscription.contracted_plan && r.effectiveSubscription.trial_active) {
      const {data: quote,error: quoteError}=await supabase.rpc('quote_subscription_transition',{p_restaurant_id:r.id,p_target_plan:planId,p_billing_cycle:selectedCycle});
      if(quoteError || !quote?.available){setFeedback({type:'error',message:quoteError?.message || quote?.reason || 'Não foi possível cotar a transição.'});return;}
      setTransitionQuote(quote);
    }
    setPixPending(null);
    setCheckoutSuccess(null);
    setCardNumber('');
    setCardHolder('');
    setCardExp('');
    setCardCvv('');
    setPayerCpfCnpj('');
    setPayerPostalCode('');
    setPayerAddressNumber('');
    setPayerPhone('');
    setPayerName('');
    setSelectedSavedCardId('new');
    setActiveTab('pix');
    setCheckoutModal({
      open: true,
      planId,
      cycle: selectedCycle,
    });
  };

  const handleCloseCheckout = () => {
    setCheckoutModal(null);
    setPixPending(null);
    setCheckoutSuccess(null);
    void loadData();
  };

  // Listener Realtime: detecção automática de pagamento do PIX via Webhook Asaas
  useEffect(() => {
    if (!pixPending?.invoiceId) return;

    const channel = supabase
      .channel(`inv-status-${pixPending.invoiceId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'subscription_invoices',
          filter: `id=eq.${pixPending.invoiceId}`,
        },
        async (payload) => {
          const updated = payload.new as {
            status?: string;
            plan_id?: SubscriptionPlanId;
            max_tables?: number | null;
            unlimited_tables?: boolean;
          };
          if (updated?.status === 'paid') {
            const confirmed = await confirmSubscriptionInvoice(pixPending.invoiceId,{restaurantId:r.id}).catch((err:unknown)=>{
              setFeedback({type:'error',message:err instanceof Error?err.message:'Não foi possível confirmar a aplicação do pagamento.'});
              void loadData();return null;
            });
            if(!confirmed || confirmed.status!=='paid')return;
            const targetPlanId = updated.plan_id || pixPending.planId;
            const resolvedUnlimited =
              updated.unlimited_tables === true ||
              data?.catalog?.[targetPlanId]?.unlimited_tables === true;
            const resolvedPlanMaxTables = resolvedUnlimited
              ? null
              : typeof updated.max_tables === 'number' && updated.max_tables > 0
                ? updated.max_tables
                : data?.catalog?.[targetPlanId]?.max_tables ?? data?.restaurant?.max_tables ?? null;
            setCheckoutSuccess({
              invoiceId: pixPending.invoiceId,
              planId: targetPlanId,
              expiresAt: '',
              maxTables: resolvedPlanMaxTables,
              unlimitedTables: resolvedUnlimited,
            });
            setPixPending(null);
            setFeedback({
              type: 'success',
              message: 'Pagamento PIX confirmado com sucesso via Asaas! Sua contratação foi confirmada.',
            });
            void loadData();
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [pixPending?.invoiceId]);

  const handleProcessPix = async () => {
    if (!checkoutModal) return;
    try {
      setCheckoutBusy(true);
      setFeedback(null);

      const cleanCpfCnpj = payerCpfCnpj.replace(/\D/g, '');
      if (cleanCpfCnpj.length !== 11 && cleanCpfCnpj.length !== 14) {
        throw new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido para emitir o PIX no Asaas.');
      }

      const res = await createSubscriptionCheckout({
        restaurantId: r.id,
        targetPlan: checkoutModal.planId,
        quoteToken: transitionQuote?.quote_token??scheduledRenewalToken,
        billingCycle: checkoutModal.cycle,
        paymentMethod: 'pix',
        payerInfo: {
          cpfCnpj: cleanCpfCnpj,
          name: payerName.trim() || r.name,
          phone: payerPhone.replace(/\D/g, ''),
        },
      });

      if (res.pix_qr_code_payload) {
        setPixPending({
          invoiceId: res.invoice_id,
          payload: res.pix_qr_code_payload,
          expiresAt: res.pix_expires_at || '',
          amountCents: res.amount_cents,
          planId: checkoutModal.planId,
          image: res.pix_qr_code_image,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao gerar cobrança PIX.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleVerifyPixPayment = async (invoiceId: string) => {
    try {
      setCheckingPayment(true);
      const res = await confirmSubscriptionInvoice(invoiceId, { restaurantId: r.id });
      if (res.status === 'paid') {
        setFeedback(null);
        const resolvedUnlimited =
          res.unlimited_tables === true ||
          data?.catalog?.[res.plan_id]?.unlimited_tables === true;
        setCheckoutSuccess({
          invoiceId: res.invoice_id,
          planId: res.plan_id,
          expiresAt: res.subscription_expires_at || '',
          maxTables: resolvedUnlimited
            ? null
            : res.max_tables ??
              data?.catalog?.[res.plan_id]?.max_tables ??
              data?.restaurant?.max_tables ??
              null,
          unlimitedTables: resolvedUnlimited,
        });
        setPixPending(null);
        void loadData();
      } else {
        setFeedback({
          type: 'error',
          message: 'Pagamento ainda não confirmado. Caso já tenha pago, aguarde alguns instantes.',
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao validar fatura.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setCheckingPayment(false);
    }
  };

  const handleProcessCardPayment = async (methodType: 'credit_card' | 'debit_card') => {
    if (!checkoutModal) return;

    try {
      setCheckoutBusy(true);
      setFeedback(null);

      const cleanCpfCnpj = payerCpfCnpj.replace(/\D/g, '');
      if (cleanCpfCnpj.length !== 11 && cleanCpfCnpj.length !== 14) {
        throw new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) do titular do cartão para o Asaas.');
      }

      let cardDataPayload: {
        holder_name?: string;
        card_number?: string;
        card_brand?: string;
        card_last4?: string;
        exp_month?: number;
        exp_year?: number;
        cvv?: string;
        save_card?: boolean;
      } | null = null;

      if (selectedSavedCardId !== 'new') {
        const saved = data?.payment_methods.find((pm) => pm.id === selectedSavedCardId);
        if (saved) {
          cardDataPayload = {
            holder_name: saved.holder_name || '',
            card_brand: saved.card_brand || '',
            card_last4: saved.card_last4 || '',
            exp_month: saved.exp_month || 12,
            exp_year: saved.exp_year || 2030,
            save_card: false,
          };
        }
      } else {
        const rawNum = cardNumber.replace(/\D/g, '');
        if (rawNum.length < 13) {
          throw new Error('Informe um número de cartão válido.');
        }
        if (!cardHolder.trim()) {
          throw new Error('Informe o nome do titular como impresso no cartão.');
        }
        const expParts = cardExp.split('/');
        const expM = parseInt(expParts[0] || '0', 10);
        let expY = parseInt(expParts[1] || '0', 10);
        if (expY < 100) expY += 2000;
        if (expM < 1 || expM > 12 || expY < 2025) {
          throw new Error('Data de validade do cartão inválida (MM/AA).');
        }
        if (cardCvv.length < 3) {
          throw new Error('Código de segurança (CVV) inválido.');
        }

        cardDataPayload = {
          holder_name: cardHolder.trim(),
          card_number: rawNum,
          card_brand: detectCardBrand(rawNum),
          card_last4: rawNum.slice(-4),
          exp_month: expM,
          exp_year: expY,
          cvv: cardCvv,
          save_card: saveCard,
        };
      }

      const res = await createSubscriptionCheckout({
        restaurantId: r.id,
        targetPlan: checkoutModal.planId,
        quoteToken: transitionQuote?.quote_token??scheduledRenewalToken,
        billingCycle: checkoutModal.cycle,
        paymentMethod: methodType,
        cardData: cardDataPayload,
        payerInfo: {
          cpfCnpj: cleanCpfCnpj,
          name: payerName.trim() || cardHolder.trim(),
          postalCode: payerPostalCode.replace(/\D/g, ''),
          addressNumber: payerAddressNumber.trim() || '1',
          phone: payerPhone.replace(/\D/g, ''),
        },
      });

      if (res.status === 'paid') {
        const resolvedUnlimited =
          res.unlimited_tables === true ||
          data?.catalog?.[res.plan_id]?.unlimited_tables === true;
        setCheckoutSuccess({
          invoiceId: res.invoice_id,
          planId: res.plan_id,
          expiresAt: res.subscription_expires_at || '',
          maxTables: resolvedUnlimited
            ? null
            : res.max_tables ??
              data?.catalog?.[res.plan_id]?.max_tables ??
              data?.restaurant?.max_tables ??
              null,
          unlimitedTables: resolvedUnlimited,
        });
        void loadData();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao processar pagamento com cartão.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleDeleteCard = async (methodId: string) => {
    if (!window.confirm('Deseja realmente remover este cartão salvo?')) return;
    try {
      await deleteSavedPaymentMethod(r.id, methodId);
      setFeedback({ type: 'success', message: 'Cartão removido com sucesso.' });
      void loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao remover cartão.';
      setFeedback({ type: 'error', message: msg });
    }
  };

  const handleSetDefaultCard = async (methodId: string) => {
    try {
      await supabase
        .from('restaurant_payment_methods')
        .update({ is_default: false })
        .eq('restaurant_id', r.id);

      await supabase
        .from('restaurant_payment_methods')
        .update({ is_default: true })
        .eq('id', methodId);

      setActiveCardMenuId(null);
      setFeedback({ type: 'success', message: 'Cartão definido como principal.' });
      void loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveNewCardModal = async () => {
    try {
      setAddCardBusy(true);
      const rawNum = cardNumber.replace(/\D/g, '');
      if (rawNum.length < 13) throw new Error('Informe um número de cartão válido.');
      if (!cardHolder.trim()) throw new Error('Informe o nome do titular do cartão.');
      const expParts = cardExp.split('/');
      const expM = parseInt(expParts[0] || '0', 10);
      let expY = parseInt(expParts[1] || '0', 10);
      if (expY < 100) expY += 2000;
      if (expM < 1 || expM > 12 || expY < 2025) throw new Error('Validade do cartão inválida (MM/AA).');
      if (cardCvv.length < 3) throw new Error('Código de segurança (CVV) inválido.');

      const brand = detectCardBrand(rawNum);
      const last4 = rawNum.slice(-4);

      if (isDefaultNewCard && data?.payment_methods.length) {
        await supabase
          .from('restaurant_payment_methods')
          .update({ is_default: false })
          .eq('restaurant_id', r.id);
      }

      const { error: insertErr } = await supabase
        .from('restaurant_payment_methods')
        .insert({
          restaurant_id: r.id,
          method_type: 'credit_card',
          holder_name: cardHolder.trim().toUpperCase(),
          card_brand: brand,
          card_last4: last4,
          exp_month: expM,
          exp_year: expY,
          gateway_token: `tok_${brand}_${last4}_${Date.now()}`,
          is_default: Boolean(isDefaultNewCard || !data?.payment_methods.length),
        });

      if (insertErr) throw new Error(insertErr.message);

      setFeedback({ type: 'success', message: 'Cartão cadastrado com sucesso. Disponível no checkout.' });
      setAddCardModalOpen(false);
      setCardNumber('');
      setCardHolder('');
      setCardExp('');
      setCardCvv('');
      void loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao cadastrar cartão.';
      alert(msg);
    } finally {
      setAddCardBusy(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPix(true);
      setTimeout(() => setCopiedPix(false), 2500);
    } catch { setFeedback({type:'error',message:'Não foi possível copiar. Selecione o código PIX e copie manualmente.'}); }
  };

  const formatCardInput = (val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 16);
    return digits.replace(/(\d{4})/g, '$1 ').trim();
  };

  const formatExpInput = (val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 4);
    if (digits.length >= 3) {
      return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }
    return digits;
  };

  if (loading && !data) {
    return (
      <div className="py-20 text-center text-zinc-500 text-sm">
        <div className="w-8 h-8 border-3 border-[#610000] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p>Carregando dados de faturamento e planos do restaurante…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="pt-6 max-w-5xl mx-auto px-4">
        <div className="p-4 bg-rose-50 text-rose-800 border border-rose-200 rounded-2xl text-sm font-semibold">
          Falha ao carregar informações: {error || 'Dados indisponíveis.'}
        </div>
      </div>
    );
  }

  const { restaurant: currentRest, usage, catalog, invoices, payment_methods: savedCards } = data;
  const currentPlan = catalog?.[currentRest.subscription_plan] || catalog?.basic;
  const catalogView = resolveSubscriptionCatalogView(catalog, cycle);
  const currentRestCycle: BillingCycle = currentRest.billing_cycle_days > 100 ? 'yearly' : 'monthly';
  const currentRestPlanView = resolveSubscriptionCatalogView(catalog, currentRestCycle).plans[currentRest.subscription_plan];
  const checkoutPlanView = checkoutModal
    ? resolveSubscriptionCatalogView(catalog, checkoutModal.cycle).plans[checkoutModal.planId]
    : null;
  const contractId=visibleContractPlan(currentRest.subscription_plan,r.effectiveSubscription);
  const contractCatalog=catalog?.[contractId??currentRest.subscription_plan];
  const contractView=resolveSubscriptionCatalogView(catalog,currentRestCycle).plans[contractId??currentRest.subscription_plan];
  const contractBenefits=contractDetailResources(contractView.tablesBenefitLabel,contractId??currentRest.subscription_plan,catalog);
  const isCurrentRestUnlimitedTables = r.effectiveSubscription?.trial_active === true || Boolean(currentRest.unlimited_tables);
  const expDate = new Date(currentRest.subscription_expires_at);
  const formattedExpDate = Number.isNaN(expDate.getTime())
    ? '-- de -- de ----'
    : expDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  const nowMs = Date.now();
  const diffDays = Math.ceil((expDate.getTime() - nowMs) / (1000 * 60 * 60 * 24));
  const daysRemainingText = diffDays > 0 ? `${diffDays} dias restantes` : `Vencido há ${Math.abs(diffDays)} dias`;

  // Status Badge
  const statusBadgeConfig = {
    active: { label: 'Assinatura Ativa', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200/60' },
    grace_period: { label: 'Período de Tolerância', bg: 'bg-amber-50 text-amber-700 border-amber-200/60' },
    expired: { label: 'Assinatura Vencida', bg: 'bg-rose-50 text-rose-700 border-rose-200/60' },
  }[currentRest.billing_status] || { label: 'Assinatura Ativa', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200/60' };


  return (
    <div className="subscription-page mx-auto text-zinc-900 dark:text-zinc-100 antialiased pb-20">
      {/* =========================================================================
          CABEÇALHO DA PÁGINA
          ========================================================================= */}
      <h1 className="sr-only">Assinatura &amp; Planos</h1>

      {/* Banner de Feedback Global */}
      {feedback && !checkoutModal?.open && (
        <div
          role="alert"
          className={`p-3.5 sm:p-4 rounded-xl text-xs sm:text-sm font-semibold flex items-center justify-between border ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-rose-50 text-rose-800 border-rose-200'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-inherit font-bold ml-4 cursor-pointer hover:opacity-75"
          >
            ✕
          </button>
        </div>
      )}

      {/* Aviso de Catálogo Incompleto / Inválido */}
      {catalogView.globalWarningMessage && (
        <div
          role="alert"
          className="p-3.5 sm:p-4 rounded-xl text-xs sm:text-sm font-semibold border bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800/60"
        >
          {catalogView.globalWarningMessage}
        </div>
      )}

      <PlanBanner/>
      <div className="subscription-overview-region"><div className="subscription-overview" aria-label="Resumo da assinatura">
        <div className="overview-cell"><BillingIcon kind="date"/><div className="overview-copy"><small>Próximo vencimento</small><strong>{formattedExpDate}</strong><span>{daysRemainingText}</span></div></div>
        <div className="overview-cell"><BillingIcon kind="tables"/><div className="overview-copy"><small>Mesas em uso</small><strong>{usage.tables_count}{isCurrentRestUnlimitedTables?' em uso':` de ${currentRest.max_tables}`}</strong><span>{isCurrentRestUnlimitedTables?'Sem limite de mesas':'Capacidade efetiva atual'}</span></div></div>
        <div className="overview-cell"><BillingIcon kind="products"/><div className="overview-copy"><small>Produtos no cardápio</small><strong>{usage.products_count} itens</strong><span>Catálogo do restaurante</span></div></div>
        <div className="overview-cell"><BillingIcon kind="payment"/><div className="overview-copy"><small>Pagamento</small><strong>{invoices[0]?.payment_method==='pix'?'PIX':invoices[0]?.payment_method==='credit_card'?'Cartão de crédito':invoices[0]?.payment_method==='debit_card'?'Cartão de débito':'A escolher'}</strong><span>{r.effectiveSubscription?.known_trial&&r.effectiveSubscription.trial_active&&!r.effectiveSubscription.contracted_plan?'Experiência Premium':PLAN_TITLES[currentRest.subscription_plan]}</span></div></div>
        <button type="button" className="overview-details" aria-controls="subscription-current-details" aria-expanded={currentDetailsOpen} onClick={()=>setCurrentDetailsOpen(value=>!value)}>Detalhes do plano atual</button>
      </div>
      </div>
      <details ref={currentDetails} open={currentDetailsOpen} onToggle={event=>setCurrentDetailsOpen(event.currentTarget.open)} id="subscription-current-details" className="subscription-current-details">
        <summary>Detalhes e ações do contrato atual</summary>
        <section className="current-contract" aria-label="Contrato atual">
          <div className="contract-card-art" aria-hidden="true"/>
          <header className="contract-identity"><div className="contract-identification"><span className={`contract-status ${currentRest.billing_status==='active'?'contract-status-active':statusBadgeConfig.bg}`}>{currentRest.billing_status==='active'&&<span className="contract-status-dot" aria-hidden="true"/>}{statusBadgeConfig.label}</span><p className="contract-restaurant">{currentRest.name}</p></div>
            <div className="contract-name"><ContractTitle plan={contractId} name={contractId?`Plano ${(contractCatalog?.name??PLAN_TITLES[contractId]).replace(/^(?:Plano\s+)+/i,'')}`:'Experiência Premium de teste'}/></div>
            <p className="contract-cycle">{contractId?(currentRestCycle==='yearly'?'Ciclo anual':'Ciclo mensal'):'Período de teste'}</p><p className="contract-description">Seu restaurante com mais controle, produtividade e resultados em um só lugar.</p>
          </header>
          <div className="contract-information">
            {(r.effectiveSubscription?.paid_start||r.effectiveSubscription?.paid_end)&&<dl className="contract-period">
              {r.effectiveSubscription?.paid_start&&<div><BillingIcon kind="date"/><div><dt>Início do período pago</dt><dd>{new Date(r.effectiveSubscription.paid_start).toLocaleString('pt-BR')}</dd></div></div>}
              {r.effectiveSubscription?.paid_end&&<div><BillingIcon kind="date"/><div><dt>Fim do período pago</dt><dd>{new Date(r.effectiveSubscription.paid_end).toLocaleString('pt-BR')}</dd></div></div>}
            </dl>}
            <div className="contract-trial-note"><PremiumTrialNote/>
              {r.effectiveSubscription?.known_trial&&r.effectiveSubscription.trial_active&&r.effectiveSubscription.contracted_plan&&r.effectiveSubscription.contracted_plan!=='premium'&&<p>Os dias gratuitos foram preservados. O plano contratado começa após o fim original do teste.</p>}
            </div>
            <h3><img src="/landing/planos/icons/card-icon.svg" alt="" aria-hidden="true" width="22" height="22"/>{contractId?'Recursos do plano contratado':'Recursos durante o teste'}</h3>
            <ul className="contract-benefits">{contractBenefits.map(feature=><li key={feature}><ContractResourceIcon label={feature}/><span>{feature}</span></li>)}</ul>
          </div>
          <div className="contract-actions"><button
              type="button"
              disabled={!currentRestPlanView?.canCheckout||!!planChange?.scheduled_change&&!planChange.can_renew}
              onClick={() => {setFeedback(null);const scheduled=planChange?.scheduled_change;void handleOpenCheckout(scheduled?.target_plan??currentRest.subscription_plan,scheduled?.billing_cycle??currentRestCycle,!!scheduled);}}
              className={`text-white text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 shadow-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#610000] focus-visible:ring-offset-2 ${
                currentRestPlanView?.canCheckout
                  ? 'bg-[#610000] hover:bg-[#4a0000] active:bg-[#3a0000] cursor-pointer'
                  : 'bg-zinc-300 dark:bg-zinc-700 text-zinc-500 cursor-not-allowed'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 21h5v-5" />
              </svg>
              <span>Renovar Ciclo Agora</span>
            </button>
<button
              type="button"
              onClick={() => {
                document.getElementById('escolha-de-planos')?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 cursor-pointer shadow-xs transition-all"
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
              <span>Fazer Upgrade de Plano</span>
            </button></div>
        </section>
      </details>
      <ScheduledDowngradePanel state={planChange} draft={downgradeDraft} busy={changeBusy} error={changeError} onSave={()=>{if(downgradeDraft)void saveDowngrade(downgradeDraft);}} onDismiss={()=>{setDowngradeDraft(null);setChangeError(null);}} onCancel={()=>void saveDowngrade(null)} onRenew={()=>{const scheduled=planChange?.scheduled_change;if(scheduled)void handleOpenCheckout(scheduled.target_plan,scheduled.billing_cycle,true);}}/>
      <SubscriptionPlanCards catalog={catalog} cycle={cycle}
        current={visibleContractPlan(currentRest.subscription_plan,r.effectiveSubscription)}
        onSelect={(plan,period)=>{setFeedback(null);void handleOpenCheckout(plan,period);}} onCycle={period=>startTransition(()=>setCycle(period))}/>
      {/* =========================================================================
          C. SEÇÃO INFERIOR — COMPARATIVO DE RECURSOS + HISTÓRICO E CARTÕES
          ========================================================================= */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Esquerda: Comparativo de Recursos (xl:col-span-6) */}
        <section className="xl:col-span-6 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-xs">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" x2="8" y1="13" y2="13" />
                <line x1="16" x2="8" y1="17" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div>
              <h3 className="font-extrabold text-sm text-zinc-900 dark:text-white">
                Comparativo de recursos
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Veja em detalhes o que cada plano oferece.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 font-bold">
                  <th className="py-2.5 px-3">Recursos</th>
                  <th className="py-2.5 px-3 text-center">Básico</th>
                  <th className="py-2.5 px-3 text-center">Profissional</th>
                  <th className="py-2.5 px-3 text-center bg-[#FDF8F5] dark:bg-amber-950/20 text-[#610000] dark:text-amber-300 rounded-t-lg">
                    Premium
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/80 font-medium text-zinc-700 dark:text-zinc-300">
                <tr>
                  <td className="py-3 px-3 font-semibold text-zinc-900 dark:text-white">Mesas simultâneas</td>
                  <td className="py-3 px-3 text-center font-bold text-zinc-800 dark:text-zinc-200">{catalogView.plans.basic.comparisonTablesLabel}</td>
                  <td className="py-3 px-3 text-center font-bold text-zinc-800 dark:text-zinc-200">{catalogView.plans.pro.comparisonTablesLabel}</td>
                  <td className="py-3 px-3 text-center font-bold text-[#610000] dark:text-amber-300 bg-[#FDF8F5] dark:bg-amber-950/20">{catalogView.plans.premium.comparisonTablesLabel}</td>
                </tr>
                <tr>
                  <td className="py-3 px-3 font-semibold text-zinc-900 dark:text-white">Cardápio Digital (QR Code)</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold bg-[#FDF8F5] dark:bg-amber-950/20">✓</td>
                </tr>
                <tr>
                  <td className="py-3 px-3 font-semibold text-zinc-900 dark:text-white">Pedidos, mesas e comandas</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold bg-[#FDF8F5] dark:bg-amber-950/20">✓</td>
                </tr>
                <tr>
                  <td className="py-3 px-3 font-semibold text-zinc-900 dark:text-white">KDS Cozinha e Bar</td>
                  <td className="py-3 px-3 text-center text-zinc-300 dark:text-zinc-600 font-bold">✕</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold">✓</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold bg-[#FDF8F5] dark:bg-amber-950/20">✓</td>
                </tr>
                <tr>
                  <td className="py-3 px-3 font-semibold text-zinc-900 dark:text-white">Gestão de Estoque e Insumos</td>
                  <td className="py-3 px-3 text-center text-zinc-300 dark:text-zinc-600 font-bold">✕</td>
                  <td className="py-3 px-3 text-center text-zinc-300 dark:text-zinc-600 font-bold">✕</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold bg-[#FDF8F5] dark:bg-amber-950/20">✓</td>
                </tr>
                <tr>
                  <td className="py-3 px-3 font-semibold text-zinc-900 dark:text-white">Financeiro e Fechamento de Caixa</td>
                  <td className="py-3 px-3 text-center text-zinc-300 dark:text-zinc-600 font-bold">✕</td>
                  <td className="py-3 px-3 text-center text-zinc-300 dark:text-zinc-600 font-bold">✕</td>
                  <td className="py-3 px-3 text-center text-emerald-600 font-bold bg-[#FDF8F5] dark:bg-amber-950/20 rounded-b-lg">✓</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Direita: Histórico de Faturas & Cartões Salvos (xl:col-span-6) */}
        <div className="xl:col-span-6 flex flex-col gap-5">
          {/* Card 1: Histórico de Faturas & Recibos */}
          <section className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-xs">
            <div className="billing-secondary-heading flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="18" height="18" x="3" y="4" rx="2" />
                    <line x1="16" x2="16" y1="2" y2="6" />
                    <line x1="8" x2="8" y1="2" y2="6" />
                    <line x1="3" x2="21" y1="10" y2="10" />
                  </svg>
                </div>
                <h3 className="font-extrabold text-sm text-zinc-900 dark:text-white">
                  Histórico de Faturas & Recibos
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (invoices.length > 0) setReceiptInvoice(invoices[0]);
                }}
                className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all cursor-pointer"
              >
                Ver histórico completo &gt;
              </button>
            </div>

            {invoices.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-400">
                Nenhuma fatura emitida até o momento.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-100 dark:border-zinc-800 text-zinc-400 font-bold">
                      <th className="py-2 px-2">Data</th>
                      <th className="py-2 px-2">Plano</th>
                      <th className="py-2 px-2">Ciclo</th>
                      <th className="py-2 px-2">Forma</th>
                      <th className="py-2 px-2">Valor</th>
                      <th className="py-2 px-2">Status</th>
                      <th className="py-2 px-2 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60 font-medium">
                    {invoices.map((inv) => {
                      const isPaid = inv.status === 'paid';
                      const isPending = inv.status === 'pending';
                      return (
                        <tr key={inv.id} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30">
                          <td className="py-2.5 px-2 text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                            {new Date(inv.created_at).toLocaleDateString('pt-BR')}
                          </td>
                          <td className="py-2.5 px-2 font-bold text-zinc-900 dark:text-white">
                            {inv.plan_id === 'basic' ? 'Básico' : inv.plan_id === 'pro' ? 'Profissional' : 'Premium'}
                          </td>
                          <td className="py-2.5 px-2 text-zinc-600 dark:text-zinc-400">
                            {inv.billing_cycle === 'yearly' ? 'Anual' : 'Mensal'}
                          </td>
                          <td className="py-2.5 px-2 font-mono text-[11px] uppercase">
                            {inv.payment_method === 'pix' ? 'PIX' : `Cartão •••• ${inv.card_last4 || ''}`}
                          </td>
                          <td className="py-2.5 px-2 font-extrabold text-zinc-900 dark:text-white">
                            {formatCurrencyBRL(inv.amount_cents)}
                          </td>
                          <td className="py-2.5 px-2">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                isPaid
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                                  : isPending
                                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                                  : 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                              }`}
                            >
                              {isPaid ? 'Pago' : isPending ? 'Pendente' : 'Falhou'}
                            </span>
                          </td>
                          <td className="py-2.5 px-2 text-right">
                            {isPaid ? (
                              <button
                                type="button"
                                onClick={() => setReceiptInvoice(inv)}
                                className="border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-[11px] font-bold text-zinc-700 dark:text-zinc-300 px-2 py-1 rounded-lg inline-flex items-center gap-1 cursor-pointer transition-colors"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                  <polyline points="7 10 12 15 17 10" />
                                  <line x1="12" x2="12" y1="15" y2="3" />
                                </svg>
                                <span>Baixar</span>
                              </button>
                            ) : inv.pix_qr_code_payload ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setPixPending({
                                    invoiceId: inv.id,
                                    payload: inv.pix_qr_code_payload || '',
                                    expiresAt: inv.pix_expires_at || '',
                                    amountCents: inv.amount_cents,
                                    planId: inv.plan_id,
                                  });
                                  setCheckoutModal({
                                    open: true,
                                    planId: inv.plan_id,
                                    cycle: inv.billing_cycle,
                                  });
                                }}
                                className="bg-[#610000] text-white text-[11px] font-bold px-2 py-1 rounded-lg cursor-pointer"
                              >
                                Pagar
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Card 2: Cartões salvos */}
          <section className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-xs relative">
            <div className="billing-secondary-heading flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600 shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="14" x="2" y="5" rx="2" />
                    <line x1="2" x2="22" y1="10" y2="10" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-zinc-900 dark:text-white">
                    Cartões salvos
                  </h3>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Gerencie os cartões disponíveis para suas contratações.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAddCardModalOpen(true)}
                className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all cursor-pointer shrink-0"
              >
                Gerenciar cartões &gt;
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              {/* Cartões Salvos Reais */}
              {savedCards.map((card) => (
                <div
                  key={card.id}
                  className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-3.5 bg-zinc-50/50 dark:bg-zinc-800/30 flex items-center justify-between relative"
                >
                  <div className="flex items-center gap-3">
                    {/* Ícone Mastercard / Visa */}
                    <div className="w-9 h-6 bg-[#eb001b] rounded flex items-center justify-center text-[9px] font-extrabold text-white uppercase tracking-tighter">
                      {card.card_brand === 'mastercard' ? 'MC' : card.card_brand === 'visa' ? 'VISA' : 'CARD'}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-extrabold text-zinc-900 dark:text-white">
                          •••• {card.card_last4}
                        </span>
                        {card.is_default && (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 rounded-md">
                            Principal
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-500 block mt-0.5">
                        Validade {String(card.exp_month).padStart(2, '0')}/{card.exp_year}
                      </span>
                    </div>
                  </div>

                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setActiveCardMenuId((curr) => (curr === card.id ? null : card.id))}
                      className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="19" r="1.5" />
                      </svg>
                    </button>

                    {activeCardMenuId === card.id && (
                      <div
                        ref={cardMenuRef}
                        className="absolute right-0 top-full mt-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg py-1.5 z-20 min-w-[150px] text-xs font-semibold"
                      >
                        {!card.is_default && (
                          <button
                            type="button"
                            onClick={() => void handleSetDefaultCard(card.id)}
                            className="w-full px-3 py-1.5 text-left text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer"
                          >
                            Definir como principal
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleDeleteCard(card.id)}
                          className="w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
                        >
                          Remover cartão
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Botão + Adicionar novo cartão */}
              <button
                type="button"
                onClick={() => setAddCardModalOpen(true)}
                className="border-2 border-dashed border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 p-4 rounded-xl flex items-center justify-center gap-2 text-xs font-bold text-zinc-700 dark:text-zinc-300 cursor-pointer min-h-[64px] hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40 transition-all"
              >
                <span className="text-base font-light">+</span>
                <span>Adicionar novo cartão</span>
              </button>
            </div>
          </section>
        </div>
      </div>

      {/* =========================================================================
          MODAL DE CHECKOUT TRANSPARENTE (PIX, CRÉDITO E DÉBITO)
          ========================================================================= */}
      {checkoutModal?.open && (
        <CheckoutShell plan={checkoutModal.planId} onClose={handleCloseCheckout}>
          <p className="checkout-subtitle">{PLAN_TITLES[checkoutModal.planId]} · Ciclo {checkoutModal.cycle==='yearly'?'Anual':'Mensal'}</p>
          {feedback?.type==='error'&&<p role="alert" className={feedback.type==='error'?'rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100':'rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100'}>{feedback.message}</p>}
            {/* Sucesso */}
            {transitionQuote && !checkoutSuccess && <CheckoutFinancialSummary
              totalLabel="Valor a pagar agora"
              periodLabel={checkoutPeriodLabel(r.effectiveSubscription)}
              price={formatCurrencyBRL(transitionQuote.full_amount_cents)}
              credit={formatCurrencyBRL(transitionQuote.credit_cents)}
              difference={formatCurrencyBRL(transitionQuote.amount_to_charge_cents)}
              start={new Date(transitionQuote.effective_at).toLocaleString('pt-BR')}
              end={new Date(transitionQuote.expires_at).toLocaleString('pt-BR')}
            />}
            {!transitionQuote&&!checkoutSuccess&&checkoutPlanView?.valid&&<CheckoutFinancialSummary
              price={formatCurrencyBRL(pixPending?.amountCents??(checkoutModal.cycle==='yearly'?checkoutPlanView.yearlyPriceCents!:checkoutPlanView.monthlyPriceCents!))}
              difference={formatCurrencyBRL(pixPending?.amountCents??(checkoutModal.cycle==='yearly'?checkoutPlanView.yearlyPriceCents!:checkoutPlanView.monthlyPriceCents!))}
              totalLabel="Valor a pagar agora"/>}
            {!checkoutSuccess&&r.effectiveSubscription?.known_trial&&r.effectiveSubscription.trial_active&&r.effectiveSubscription.original_trial_end&&<p className="checkout-trial-info">Durante o teste, sua capacidade continua ilimitada até {new Date(r.effectiveSubscription.original_trial_end).toLocaleString('pt-BR')}. O período pago começa após o prazo gratuito.</p>}
            {checkoutSuccess ? (
              <div className="text-center py-6 space-y-4">
                <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 mx-auto flex items-center justify-center">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h4 className="text-lg font-extrabold text-zinc-900 dark:text-white">
                  Pagamento confirmado
                </h4>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto">
                  {r.effectiveSubscription?.trial_active && r.effectiveSubscription.original_trial_end ? <>
                    Contratação do <strong>{PLAN_TITLES[checkoutSuccess.planId]}</strong> confirmada.
                    O período pago começa em {new Date(r.effectiveSubscription.original_trial_end).toLocaleString('pt-BR')}.
                    Até lá, sua experiência continua Premium, com mesas ilimitadas.
                  </> : <>                  Sua assinatura do <strong>{PLAN_TITLES[checkoutSuccess.planId]}</strong> foi ativada. Sua capacidade agora é de{' '}
                  <strong>
                    {checkoutSuccess.unlimitedTables
                      ? 'mesas simultâneas ilimitadas'
                      : `${checkoutSuccess.maxTables} mesas simultâneas`}
                  </strong>
                  .
                  </>}
                </p>
                <button
                  type="button"
                  onClick={handleCloseCheckout}
                  className="px-6 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold transition-all shadow-md cursor-pointer"
                >
                  Voltar ao Painel
                </button>
              </div>
            ) : pixPending ? (
              /* PIX data comes exclusively from the existing server response. */
              <div>
                <div className="checkout-pix">
                  <div className="checkout-pix-grid"><div><h3>Pague via PIX</h3><p>Escaneie o QR Code no app do seu banco ou use o código Copia e Cola.</p><p><strong>{formatCurrencyBRL(pixPending.amountCents)}</strong></p></div><div className="checkout-qr">
                    {pixPending.image?<img src={pixPending.image} alt="QR Code PIX da cobrança" width="192" height="192"/>:<QRCodeSVG value={pixPending.payload} size={192} level="M"/>}
                  </div></div>
                  <div className="checkout-code"><div><label htmlFor="checkout-pix-code">Código PIX (Copia e Cola)</label><input id="checkout-pix-code" type="text" readOnly value={pixPending.payload}/></div><button type="button" onClick={()=>void copyToClipboard(pixPending.payload)}>{copiedPix?'Copiado!':'Copiar'}</button></div>
                  <p role="status" className="sr-only">{copiedPix?'Código PIX copiado.':''}</p>
                </div>
                <button type="button" className="checkout-consult" disabled={checkingPayment} onClick={()=>void handleVerifyPixPayment(pixPending.invoiceId)}>{checkingPayment?'Consultando pagamento…':'Já realizei o pagamento · Consultar'}</button>
              </div>
            ) : (
              /* Formulário com Abas PIX e Cartão */
              <div className="space-y-4">
                <div className="flex border-b border-zinc-200 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setActiveTab('pix')}
                    className={`flex-1 py-2 text-xs font-bold border-b-2 cursor-pointer transition-all ${
                      activeTab === 'pix' ? 'border-[#610000] text-[#610000] dark:border-red-400 dark:text-red-300' : 'border-transparent text-zinc-400'
                    }`}
                  >
                    PIX Instantâneo
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('credit_card')}
                    className={`flex-1 py-2 text-xs font-bold border-b-2 cursor-pointer transition-all ${
                      activeTab === 'credit_card' ? 'border-[#610000] text-[#610000] dark:border-red-400 dark:text-red-300' : 'border-transparent text-zinc-400'
                    }`}
                  >
                    Cartão de Crédito
                  </button>
                </div>

                {activeTab === 'pix' && (
                  <div className="space-y-3 pt-2">
                    <div className="p-3 bg-zinc-50 dark:bg-zinc-800/50 rounded-xl text-xs text-zinc-500">
                      A contratação será concluída após a confirmação do pagamento.
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                        CPF ou CNPJ do pagador: *
                      </label>
                      <input
                        type="text"
                        placeholder="000.000.000-00 ou 00.000.000/0000-00"
                        value={payerCpfCnpj}
                        onChange={(e) => setPayerCpfCnpj(formatCpfCnpj(e.target.value))}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={checkoutBusy}
                      onClick={() => void handleProcessPix()}
                      className="w-full py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white font-bold text-xs cursor-pointer shadow-md transition-colors"
                    >
                      {checkoutBusy ? 'Gerando QR Code PIX…' : transitionQuote ? 'Gerar PIX da diferença' : 'Gerar PIX e Pagar Agora'}
                    </button>
                  </div>
                )}

                {activeTab === 'credit_card' && (
                  <div className="space-y-3 pt-2">
                    {savedCards.length > 0 && (
                      <div>
                        <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                          Cartão para cobrança:
                        </label>
                        <select
                          value={selectedSavedCardId}
                          onChange={(e) => setSelectedSavedCardId(e.target.value)}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800"
                        >
                          <option value="new">+ Usar um novo cartão</option>
                          {savedCards.map((sc) => (
                            <option key={sc.id} value={sc.id}>
                              {sc.card_brand?.toUpperCase()} •••• {sc.card_last4} (Exp: {sc.exp_month}/{sc.exp_year})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {selectedSavedCardId === 'new' && (
                      <>
                        <div>
                          <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                            CPF ou CNPJ do titular: *
                          </label>
                          <input
                            type="text"
                            placeholder="000.000.000-00 ou 00.000.000/0000-00"
                            value={payerCpfCnpj}
                            onChange={(e) => setPayerCpfCnpj(formatCpfCnpj(e.target.value))}
                            className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                            Número do Cartão:
                          </label>
                          <input
                            type="text"
                            placeholder="0000 0000 0000 0000"
                            value={cardNumber}
                            onChange={(e) => setCardNumber(formatCardInput(e.target.value))}
                            className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                            Nome impresso no Cartão:
                          </label>
                          <input
                            type="text"
                            placeholder="NOME COMO NO CARTAO"
                            value={cardHolder}
                            onChange={(e) => setCardHolder(e.target.value.toUpperCase())}
                            className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 uppercase"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                              Validade (MM/AA):
                            </label>
                            <input
                              type="text"
                              placeholder="MM/AA"
                              value={cardExp}
                              onChange={(e) => setCardExp(formatExpInput(e.target.value))}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                              CVV:
                            </label>
                            <input
                              type="password"
                              maxLength={4}
                              placeholder="123"
                              value={cardCvv}
                              onChange={(e) => setCardCvv(e.target.value.replace(/\D/g, ''))}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                              CEP de cobrança:
                            </label>
                            <input
                              type="text"
                              placeholder="00000-000"
                              value={payerPostalCode}
                              onChange={(e) => setPayerPostalCode(formatCep(e.target.value))}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                              Número:
                            </label>
                            <input
                              type="text"
                              placeholder="Ex: 100"
                              value={payerAddressNumber}
                              onChange={(e) => setPayerAddressNumber(e.target.value)}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800"
                            />
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs cursor-pointer text-zinc-600 dark:text-zinc-400">
                          <input
                            type="checkbox"
                            checked={saveCard}
                            onChange={(e) => setSaveCard(e.target.checked)}
                          />
                          <span>Salvar cartão para futuras renovações da assinatura</span>
                        </label>
                      </>
                    )}

                    <button
                      type="button"
                      disabled={checkoutBusy}
                      onClick={() => void handleProcessCardPayment('credit_card')}
                      className="w-full py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white font-bold text-xs cursor-pointer shadow-md transition-colors"
                    >
                      {checkoutBusy ? 'Processando transação…' : transitionQuote ? 'Pagar diferença e confirmar upgrade' : 'Pagar e Ativar Plano Agora'}
                    </button>
                  </div>
                )}
              </div>
            )}
        </CheckoutShell>
      )}

      {/* =========================================================================
          MODAL DE COMPROVANTE / RECIBO DE FATURA
          ========================================================================= */}
      {receiptInvoice && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-in fade-in duration-200"
        >
          <div className="bg-white dark:bg-zinc-900 rounded-3xl max-w-md w-full p-6 border border-zinc-200 dark:border-zinc-800 shadow-2xl space-y-4 text-zinc-900 dark:text-zinc-100">
            <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 pb-3">
              <div>
                <h3 className="text-base font-extrabold text-zinc-900 dark:text-white">
                  Recibo de Assinatura
                </h3>
                <p className="text-xs text-zinc-500 font-mono">
                  #{receiptInvoice.id.slice(0, 8).toUpperCase()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReceiptInvoice(null)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs bg-zinc-50 dark:bg-zinc-800/40 p-4 rounded-xl border border-zinc-200/60 dark:border-zinc-800">
              <div className="flex justify-between">
                <span className="text-zinc-500">Restaurante:</span>
                <span className="font-bold">{currentRest.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Plano:</span>
                <span className="font-bold">{PLAN_TITLES[receiptInvoice.plan_id] || receiptInvoice.plan_id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Ciclo:</span>
                <span className="font-bold">{receiptInvoice.billing_cycle === 'yearly' ? 'Anual (12 meses)' : 'Mensal (30 dias)'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Forma de Pagamento:</span>
                <span className="font-bold">{receiptInvoice.payment_method === 'pix' ? 'PIX Instantâneo' : `Cartão •••• ${receiptInvoice.card_last4 || ''}`}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Data de Emissão:</span>
                <span className="font-bold">{new Date(receiptInvoice.created_at).toLocaleDateString('pt-BR')}</span>
              </div>
              <div className="flex justify-between border-t border-zinc-200 dark:border-zinc-700 pt-2 text-sm font-extrabold">
                <span>Valor Total Pago:</span>
                <span className="text-emerald-600">{formatCurrencyBRL(receiptInvoice.amount_cents)}</span>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="flex-1 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-xs font-bold text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect width="12" height="8" x="6" y="14" />
                </svg>
                <span>Imprimir Recibo</span>
              </button>
              <button
                type="button"
                onClick={() => setReceiptInvoice(null)}
                className="flex-1 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold cursor-pointer transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL ADICIONAR NOVO CARTÃO
          ========================================================================= */}
      {addCardModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-in fade-in duration-200"
        >
          <div className="bg-white dark:bg-zinc-900 rounded-3xl max-w-md w-full p-6 border border-zinc-200 dark:border-zinc-800 shadow-2xl space-y-4 text-zinc-900 dark:text-zinc-100">
            <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 pb-3">
              <div>
                <h3 className="text-base font-extrabold text-zinc-900 dark:text-white">
                  Adicionar Novo Cartão
                </h3>
                <p className="text-xs text-zinc-500">
                  Cadastre um cartão para suas próximas contratações.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddCardModalOpen(false)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                  Número do Cartão:
                </label>
                <input
                  type="text"
                  placeholder="0000 0000 0000 0000"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(formatCardInput(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                  Nome impresso no Cartão:
                </label>
                <input
                  type="text"
                  placeholder="NOME COMO NO CARTAO"
                  value={cardHolder}
                  onChange={(e) => setCardHolder(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 uppercase"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                    Validade (MM/AA):
                  </label>
                  <input
                    type="text"
                    placeholder="MM/AA"
                    value={cardExp}
                    onChange={(e) => setCardExp(formatExpInput(e.target.value))}
                    className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                    CVV:
                  </label>
                  <input
                    type="password"
                    maxLength={4}
                    placeholder="123"
                    value={cardCvv}
                    onChange={(e) => setCardCvv(e.target.value.replace(/\D/g, ''))}
                    className="w-full px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs cursor-pointer text-zinc-600 dark:text-zinc-400 pt-1">
                <input
                  type="checkbox"
                  checked={isDefaultNewCard}
                  onChange={(e) => setIsDefaultNewCard(e.target.checked)}
                />
                <span>Definir como cartão principal para renovação</span>
              </label>

              <button
                type="button"
                disabled={addCardBusy}
                onClick={() => void handleSaveNewCardModal()}
                className="w-full py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white font-bold text-xs cursor-pointer shadow-md transition-colors mt-2"
              >
                {addCardBusy ? 'Cadastrando cartão…' : 'Salvar Cartão'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          RODAPÉ DE TERMOS E RESPONSABILIDADE FISCAL
          ========================================================================= */}
      <div className="pt-6 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
        <span>
          Plataforma Elozi SaaS — Sistema de gestão operacional de pedidos, comandas e atendimento em mesa.
        </span>
        <button
          type="button"
          onClick={() => setTermsModalOpen(true)}
          className="font-bold underline text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 cursor-pointer"
        >
          Termos de Uso e Responsabilidade Fiscal
        </button>
      </div>

      <TermsOfUseModal open={termsModalOpen} onClose={() => setTermsModalOpen(false)} />
    </div>
  );
}
