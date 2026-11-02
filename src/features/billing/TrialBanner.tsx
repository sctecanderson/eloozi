import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import {
  NOTICE_TIMING,
  nextNotice,
  noticePaused,
  premiumTrialNote,
  subscriptionNotices,
} from './subscriptionNotices';

export interface EffectiveSubscription {
  known_trial: boolean;
  trial_active: boolean;
  original_trial_start?: string;
  original_trial_end?: string;
  contracted_plan?: 'basic' | 'pro' | 'premium' | null;
  paid_start?: string | null;
  paid_end?: string | null;
  plan: string;
  billing_status: string;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  return reduced;
}

export type BannerVisualTheme = 'amber' | 'red' | 'regularized';

export function TrialBanner() {
  const { restaurant: r } = useRestaurant();

  // Estados reais de assinatura já calculados pelo sistema
  const isTrial = r.subscriptionIsTrial === true || Boolean(r.effectiveSubscription?.trial_active);

  let diffDays: number | null = null;
  if (r.subscriptionExpiresAt) {
    const diffMs = new Date(r.subscriptionExpiresAt).getTime() - Date.now();
    diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  } else if (r.effectiveSubscription?.original_trial_end) {
    const diffMs = new Date(r.effectiveSubscription.original_trial_end).getTime() - Date.now();
    diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  const isExpiringSoon = diffDays !== null && diffDays > 0 && diffDays <= 5;
  const isGracePeriod = !isTrial && ((diffDays !== null && diffDays <= 0 && diffDays >= -3) || r.billingStatus === 'grace_period');
  const isSevereOverdue = isTrial
    ? (diffDays !== null && diffDays <= 0) || r.billingStatus === 'expired'
    : (diffDays !== null && diffDays < -3) || (r.billingStatus === 'expired' && (diffDays === null || diffDays <= -3));

  const isRegularized = !isTrial && !isExpiringSoon && !isGracePeriod && !isSevereOverdue && r.billingStatus === 'active';

  // Mensagens rotativas ou texto contextual de assinatura
  const baseNotices = subscriptionNotices(r.effectiveSubscription);
  let messages: string[] = [];

  if (baseNotices.length > 0) {
    messages = baseNotices;
  } else if (isSevereOverdue) {
    messages = [
      isTrial
        ? 'Seu período de teste gratuito de 7 dias chegou ao fim. Escolha um plano para restabelecer os serviços.'
        : 'Assinatura suspensa. Efetue o pagamento da fatura em aberto para restabelecer os serviços.',
    ];
  } else if (isGracePeriod) {
    messages = ['Atenção (Período de Tolerância): sua assinatura venceu. Regularize para evitar a suspensão do sistema.'];
  } else if (isExpiringSoon) {
    messages = [
      r.subscriptionPlan
        ? `Renovação de Assinatura: restam ${diffDays} ${diffDays === 1 ? 'dia' : 'dias'} para o término do seu plano.`
        : `Sua assinatura expira em ${diffDays} ${diffDays === 1 ? 'dia' : 'dias'}. Renove para manter o serviço.`,
    ];
  } else if (isRegularized && r.subscriptionPlan) {
    const planName = r.subscriptionPlan.charAt(0).toUpperCase() + r.subscriptionPlan.slice(1);
    messages = [`Plano ${planName} ativo · Recursos operacionais e salão liberados.`];
  }

  const signature = messages.join('\n');
  const [index, setIndex] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  const reduced = useReducedMotion();
  const paused = noticePaused(userPaused, hover, focus, reduced);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const text = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const manualCenter = useRef(false);
  const description = useId();
  const current = nextNotice(index, 0, messages.length);

  useLayoutEffect(() => {
    if (!text.current || reduced || messages.length < 2) return;
    const { travel, hold, total } = NOTICE_TIMING;
    const motion = text.current.animate(
      [
        { transform: 'translateX(100%)', opacity: 0, offset: 0 },
        { transform: 'translateX(0)', opacity: 1, offset: travel / total },
        { transform: 'translateX(0)', opacity: 1, offset: (travel + hold) / total },
        { transform: 'translateX(-100%)', opacity: 0, offset: 1 },
      ],
      { duration: total, easing: 'linear', fill: 'both' }
    );
    animation.current = motion;
    if (manualCenter.current) {
      motion.currentTime = travel;
      manualCenter.current = false;
    }
    if (pausedRef.current) motion.pause();
    motion.onfinish = () => setIndex((i) => nextNotice(i, 1, messages.length));
    return () => {
      motion.onfinish = null;
      motion.cancel();
      animation.current = null;
    };
  }, [current, signature, reduced, messages.length]);

  useLayoutEffect(() => {
    if (paused) animation.current?.pause();
    else animation.current?.play();
  }, [paused]);

  if (!messages.length) return null;

  const move = (delta: number) => {
    manualCenter.current = true;
    setIndex((i) => nextNotice(i, delta, messages.length));
  };

  // Determinar tema visual: Âmbar (trial / vencimento / tolerância), Vermelho (vencido/bloqueado) ou Regularizado (discreto)
  const isAmber = isTrial || isExpiringSoon || isGracePeriod;
  const isRed = isSevereOverdue;

  const themeClass = isRed
    ? 'border-red-400/80 bg-red-500/15 text-red-950 dark:border-red-500/50 dark:bg-red-950/45 dark:text-red-100'
    : isAmber
      ? 'border-amber-400/80 bg-amber-500/15 text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/45 dark:text-amber-100'
      : 'border-zinc-200 bg-zinc-100/90 text-zinc-800 dark:border-zinc-700/80 dark:bg-zinc-800/60 dark:text-zinc-200';

  const buttonStyle = isRed
    ? 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-red-500/20 dark:hover:bg-red-500/30 text-red-950 dark:text-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 cursor-pointer transition-colors'
    : isAmber
      ? 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-amber-500/20 dark:hover:bg-amber-500/30 text-amber-950 dark:text-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 cursor-pointer transition-colors'
      : 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-600 cursor-pointer transition-colors';

  const ctaStyle = isRed
    ? 'bg-red-600 hover:bg-red-700 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow-2xs transition-colors'
    : isAmber
      ? 'bg-amber-600 hover:bg-amber-700 text-white dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-zinc-950 font-bold text-xs px-3 py-1.5 rounded-lg shadow-2xs transition-colors'
      : 'border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-zinc-800 dark:text-white hover:bg-zinc-50 dark:hover:bg-zinc-650 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors';

  const ctaLabel = isRed
    ? 'Regularizar'
    : isGracePeriod
      ? 'Regularizar'
      : isExpiringSoon
        ? 'Renovar'
        : isTrial
          ? (r.effectiveSubscription?.contracted_plan ? 'Ver plano' : 'Escolher plano')
          : 'Ver assinatura';

  return (
    <aside
      aria-label="Informações da assinatura do restaurante"
      aria-describedby={description}
      className={`mx-4 mt-3 flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 shadow-xs transition-colors ${themeClass}`}
      onMouseEnter={() => {
        animation.current?.pause();
        setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => {
        animation.current?.pause();
        setFocus(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(false);
      }}
    >
      {/* Ícone contextual de status */}
      <span className="shrink-0 flex items-center justify-center" aria-hidden="true">
        {isRed ? (
          <svg className="w-4 h-4 text-red-600 dark:text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ) : isAmber ? (
          <svg className="w-4 h-4 text-amber-600 dark:text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-zinc-500 dark:text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>

      {/* Descrição acessível para leitores de tela */}
      <ul id={description} className="sr-only">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>

      {/* Viewport rotativo de mensagens */}
      <div className="relative min-w-0 flex-1 overflow-hidden" aria-hidden="true" data-notice-viewport>
        <div className="grid invisible text-center text-xs leading-5 sm:text-sm font-medium">
          {messages.map((m) => (
            <p className="col-start-1 row-start-1 px-1 truncate" key={m}>
              {m}
            </p>
          ))}
        </div>
        <div
          ref={text}
          data-notice-message
          className="absolute inset-0 flex items-center justify-center px-1 text-center text-xs leading-5 sm:text-sm font-semibold tracking-tight truncate"
        >
          {messages[current]}
        </div>
      </div>

      {/* Controles de Navegação e Botão de Ação */}
      <div className="flex shrink-0 items-center gap-1">
        {messages.length > 1 && (
          <>
            <button
              type="button"
              className={buttonStyle}
              aria-label="Mensagem anterior"
              onClick={() => move(-1)}
            >
              ‹
            </button>
            {!reduced && (
              <button
                type="button"
                className={buttonStyle}
                aria-label={userPaused ? 'Retomar mensagens' : 'Pausar mensagens'}
                aria-pressed={userPaused}
                onClick={() => setUserPaused((p) => !p)}
              >
                <span aria-hidden="true">{userPaused ? '▶' : 'Ⅱ'}</span>
              </button>
            )}
            <button
              type="button"
              className={buttonStyle}
              aria-label="Próxima mensagem"
              onClick={() => move(1)}
            >
              ›
            </button>
          </>
        )}
        <Link
          to={`/${r.slug}/admin/assinatura`}
          className={ctaStyle}
          aria-label={`${ctaLabel} - Assinatura & Planos`}
        >
          <span>{ctaLabel}</span>
        </Link>
      </div>
    </aside>
  );
}

export function PremiumTrialNote() {
  const { restaurant: r } = useRestaurant();
  const note = premiumTrialNote(r.effectiveSubscription);
  return note ? (
    <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-300">{note}</p>
  ) : null;
}
