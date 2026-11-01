import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { supabase } from '../../lib/supabase';
import { TermsOfUseModal } from '../../components/TermsOfUseModal';

function slugifyRestaurantName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function formatPhoneBR(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length === 0) return '';
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

interface OnboardingResult {
  restaurant_id: string;
  slug: string;
  name: string;
  trial_expires_at: string;
}

export function PublicOnboardingPage() {
  const navigate = useNavigate();

  const currentHost =
    typeof window !== 'undefined' &&
    window.location.host &&
    !window.location.host.includes('localhost')
      ? window.location.host
      : 'elozi.vercel.app';

  const [restaurantName, setRestaurantName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [termsModalOpen, setTermsModalOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRestaurantNameChange = (value: string) => {
    setRestaurantName(value);
    if (!slugTouched) {
      setSlug(slugifyRestaurantName(value));
    }
  };

  const handleSlugChange = (value: string) => {
    setSlugTouched(true);
    const sanitized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 48);
    setSlug(sanitized);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = restaurantName.trim();
    const trimmedSlug = slug.replace(/^-+|-+$/g, '').trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (trimmedName.length < 2) {
      setError('Informe o nome do restaurante (mínimo 2 caracteres).');
      return;
    }

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmedSlug) || trimmedSlug.length < 3) {
      setError('O endereço (slug) deve conter apenas letras minúsculas, números e hífens (mínimo 3 caracteres).');
      return;
    }

    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setError('Informe um e-mail válido para o administrador.');
      return;
    }

    if (password.length < 6) {
      setError('A senha deve ter no mínimo 6 caracteres.');
      return;
    }

    if (!acceptedTerms) {
      setError('Você precisa ler e concordar com os Termos de Uso e Responsabilidade Fiscal para continuar.');
      return;
    }

    if (!supabase) {
      setError('Conexão com o banco de dados não configurada neste ambiente.');
      return;
    }

    setSubmitting(true);

    try {
      // 1. Verifica se já existe sessão ativa ou realiza o cadastro do administrador
      const { data: currentSessionData } = await supabase.auth.getSession();
      let activeSession = currentSessionData?.session ?? null;

      if (!activeSession || activeSession.user.email?.toLowerCase() !== trimmedEmail) {
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
        });

        if (signUpError) {
          // Caso o usuário já possua cadastro no Auth, tenta autenticar com a senha fornecida
          if (
            signUpError.message.toLowerCase().includes('already registered') ||
            signUpError.message.toLowerCase().includes('already been registered')
          ) {
            const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
              email: trimmedEmail,
              password,
            });
            if (signInError) {
              throw new Error(
                'Este e-mail já possui cadastro. Verifique sua senha ou faça login para continuar.'
              );
            }
            activeSession = signInData.session;
          } else {
            throw signUpError;
          }
        } else {
          activeSession = signUpData.session;
          if (!activeSession && signUpData.user) {
            // Se o Supabase não retornou sessão imediata no signUp, tenta signInWithPassword
            const { data: signInData } = await supabase.auth.signInWithPassword({
              email: trimmedEmail,
              password,
            });
            activeSession = signInData.session;
          }
        }
      }

      if (!activeSession) {
        throw new Error(
          'Não foi possível iniciar a sessão autenticada. Verifique se a confirmação de e-mail está pendente.'
        );
      }

      // 2. Chama a RPC de auto-cadastro com seed automático (168 horas Premium Trial)
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        'register_trial_restaurant_onboarding',
        {
          p_restaurant_name: trimmedName,
          p_slug: trimmedSlug,
          p_phone: phone.trim() || null,
        }
      );

      if (rpcError) {
        throw new Error(rpcError.message || 'Erro ao provisionar o restaurante.');
      }

      const result = rpcData as OnboardingResult;
      const targetSlug = result?.slug || trimmedSlug;

      // 3. Redireciona direto para o painel administrativo do novo restaurante
      navigate(`/${targetSlug}/admin`, { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Não foi possível concluir o cadastro.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between py-6 sm:py-10 px-4 sm:px-6 lg:px-8 bg-[#FAF7F2] bg-[url('/landing/background.png')] bg-cover bg-center bg-no-repeat text-zinc-900">
      <div className="w-full max-w-2xl mx-auto">
        {/* Barra Superior: Logo à esquerda, link Voltar ao início à direita */}
        <div className="flex items-center justify-between mb-6">
          <Link to="/" className="inline-flex items-center select-none group">
            <img
              src="/landing/Eloozi.png"
              alt="Elozi"
              className="h-10 w-auto object-contain transition-transform group-hover:scale-102"
            />
          </Link>

          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-zinc-700 hover:text-zinc-950 transition-colors"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            <span>Voltar ao início</span>
          </Link>
        </div>

        {/* Card Principal */}
        <div className="bg-white/95 backdrop-blur-xs rounded-3xl border border-stone-200/90 p-6 sm:p-8 md:p-10 shadow-xl shadow-stone-900/5">
          {/* Cabeçalho do Card */}
          <div className="mb-6">
            <div className="flex items-center gap-2">
              <div className="w-5 h-1 bg-red-600 rounded-full" />
              <span className="text-xs font-bold text-red-600 tracking-wider uppercase">
                AUTOATENDIMENTO SAAS ELOZI
              </span>
            </div>
            <h1 className="font-extrabold text-2xl sm:text-3xl text-zinc-900 tracking-tight mt-1.5">
              Crie seu restaurante
            </h1>
            <p className="text-sm text-zinc-600 mt-1 leading-relaxed">
              Seu ambiente será criado com mesas, cardápio demonstrativo e KDS pronto para testar.
            </p>
          </div>

          {/* Alerta de Erro */}
          {error && (
            <div
              role="alert"
              className="mb-5 p-4 rounded-2xl border border-red-200 bg-red-50 text-red-700 text-sm font-medium flex items-start gap-3"
            >
              <svg
                className="w-5 h-5 shrink-0 mt-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Formulário */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Nome do Restaurante */}
            <div>
              <label
                htmlFor="onb-restaurant-name"
                className="block text-xs font-bold text-zinc-800 uppercase tracking-wider mb-1.5"
              >
                Nome do Restaurante *
              </label>
              <input
                id="onb-restaurant-name"
                type="text"
                required
                placeholder="Ex.: Pizzaria Bella Napoli"
                value={restaurantName}
                onChange={(e) => handleRestaurantNameChange(e.target.value)}
                className="w-full rounded-xl border border-stone-300 bg-stone-50/70 px-4 py-3 text-sm font-medium text-zinc-900 placeholder-zinc-400 focus:bg-white focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600/20 transition-all"
              />
            </div>

            {/* Endereço Exclusivo (URL) */}
            <div>
              <label
                htmlFor="onb-slug"
                className="block text-xs font-bold text-zinc-800 uppercase tracking-wider mb-1.5"
              >
                Endereço Exclusivo do Cardápio (URL) *
              </label>
              <div className="flex items-center rounded-xl border border-stone-300 bg-stone-50/70 overflow-hidden focus-within:border-red-600 focus-within:bg-white focus-within:ring-2 focus-within:ring-red-600/20 transition-all">
                <span className="px-3.5 py-3 text-sm font-mono text-zinc-500 bg-stone-100 border-r border-stone-200 select-none">
                  {currentHost}/
                </span>
                <input
                  id="onb-slug"
                  type="text"
                  required
                  placeholder="pizzaria-bella-napoli"
                  value={slug}
                  onChange={(e) => handleSlugChange(e.target.value)}
                  className="w-full px-3.5 py-3 text-sm font-mono font-semibold text-zinc-900 placeholder-zinc-400 bg-transparent focus:outline-none"
                />
              </div>
              <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
                Cardápio: <strong className="text-zinc-800 font-mono">{currentHost}/{slug || 'seu-restaurante'}</strong> • Painel: <strong className="text-zinc-800 font-mono">{currentHost}/{slug || 'seu-restaurante'}/admin</strong>
              </p>
            </div>

            {/* WhatsApp / Telefone */}
            <div>
              <label
                htmlFor="onb-phone"
                className="block text-xs font-bold text-zinc-800 uppercase tracking-wider mb-1.5"
              >
                WhatsApp / Telefone Comercial
              </label>
              <input
                id="onb-phone"
                type="tel"
                placeholder="(47) 99999-9999"
                value={phone}
                onChange={(e) => setPhone(formatPhoneBR(e.target.value))}
                className="w-full rounded-xl border border-stone-300 bg-stone-50/70 px-4 py-3 text-sm font-medium text-zinc-900 placeholder-zinc-400 focus:bg-white focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600/20 transition-all"
              />
            </div>

            {/* Grid de 2 colunas: Email e Senha */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="onb-email"
                  className="block text-xs font-bold text-zinc-800 uppercase tracking-wider mb-1.5"
                >
                  E-mail do Administrador *
                </label>
                <input
                  id="onb-email"
                  type="email"
                  required
                  placeholder="voce@restaurante.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-stone-300 bg-stone-50/70 px-4 py-3 text-sm font-medium text-zinc-900 placeholder-zinc-400 focus:bg-white focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600/20 transition-all"
                />
              </div>

              <div>
                <label
                  htmlFor="onb-password"
                  className="block text-xs font-bold text-zinc-800 uppercase tracking-wider mb-1.5"
                >
                  Senha de Acesso *
                </label>
                <div className="relative">
                  <input
                    id="onb-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    placeholder="Mínimo 6 caracteres"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-stone-300 bg-stone-50/70 px-4 py-3 pr-11 text-sm font-medium text-zinc-900 placeholder-zinc-400 focus:bg-white focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600/20 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Ocultar senha' : 'Exibir senha'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 p-1 cursor-pointer"
                  >
                    {showPassword ? (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Card Informativo de Benefícios */}
            <div className="rounded-2xl p-4.5 border border-zinc-200/70 bg-[#FAF7F2]/90 mt-4">
              <div className="flex items-center gap-2 text-xs font-bold text-zinc-800 uppercase tracking-wide">
                <svg
                  className="w-4 h-4 text-red-600"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="8" width="18" height="4" rx="1" />
                  <path d="M12 8v13" />
                  <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
                  <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 4.8 0 0 1 12 8a4.8 4.8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
                </svg>
                <span>INCLUSO NO TESTE GRÁTIS DE 7 DIAS (PREMIUM COMPLETO):</span>
              </div>
              <ul className="mt-2.5 space-y-2 text-xs text-zinc-700">
                <li className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-red-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Mesas ilimitadas com QR Codes para impressão</span>
                </li>
                <li className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-red-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>3 mesas e 5 produtos pré-cadastrados</span>
                </li>
                <li className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-red-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>KDS de cozinha e bar em tempo real</span>
                </li>
                <li className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-red-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Estoque e Financeiro incluídos durante o teste Premium</span>
                </li>
              </ul>
            </div>

            {/* Checkbox Termos de Uso */}
            <div className="pt-2">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded border-stone-300 text-red-600 focus:ring-red-600 cursor-pointer"
                />
                <span className="text-xs text-zinc-600 leading-relaxed">
                  Li e concordo com os{' '}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setTermsModalOpen(true);
                    }}
                    className="font-bold text-zinc-900 underline hover:text-red-600 transition-colors"
                  >
                    Termos de Uso e Responsabilidade Fiscal da Plataforma Elozi
                  </button>
                  .
                </span>
              </label>
            </div>

            {/* Botão de Ação Primário */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-4 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold text-base shadow-lg shadow-red-600/20 transition-all flex items-center justify-center gap-2 active:scale-[0.99] disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Provisionando Restaurante e Cardápio...</span>
                </span>
              ) : (
                <>
                  <span>Criar meu restaurante e iniciar teste de 7 dias</span>
                  <span aria-hidden="true" className="text-lg leading-none">→</span>
                </>
              )}
            </button>

            {/* Microcopy */}
            <div className="flex items-center justify-center gap-1.5 text-xs text-zinc-500 pt-1">
              <svg className="w-4 h-4 text-emerald-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <span>7 dias para testar • Sem compromisso • Seus dados protegidos</span>
            </div>
          </form>
        </div>
      </div>

      <TermsOfUseModal open={termsModalOpen} onClose={() => setTermsModalOpen(false)} />
    </div>
  );
}
