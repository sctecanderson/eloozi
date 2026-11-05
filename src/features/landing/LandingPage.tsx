import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '../../lib/supabase';
import { QRCodeSVG } from 'qrcode.react';
import './landing-page.css';

function IconSun({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function IconMoon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function IconZap({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function IconShieldCheck({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function IconCloud({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

function IconHeadset({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z" />
      <path d="M21 16v2a4 4 0 0 1-4 4h-5" />
    </svg>
  );
}

function IconCheck({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconStore({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10h18l-1.4-6H4.4L3 10Z" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
      <path d="M3 10a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0" />
    </svg>
  );
}

function IconLayers({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </svg>
  );
}

function IconScan({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" />
      <path d="M7 12h10" />
    </svg>
  );
}

type SegmentIconType =
  | 'burger'
  | 'pizza'
  | 'coffee'
  | 'bar'
  | 'steak'
  | 'cupcake'
  | 'darkkitchen'
  | 'buffet';

function SegmentIcon({ type, className = 'w-5 h-5' }: { type: SegmentIconType; className?: string }) {
  switch (type) {
    case 'burger':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 11h16a1 1 0 0 0 1-1c0-3.87-3.8-7-9-7s-9 3.13-9 7a1 1 0 0 0 1 1Z" />
          <path d="M3 14h18" />
          <path d="M4 17h16a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a1 1 0 0 1 1-1Z" />
          <path d="M8.5 7.5h.01" />
          <path d="M12 6.5h.01" />
          <path d="M15.5 7.5h.01" />
        </svg>
      );
    case 'pizza':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 11h.01" />
          <path d="M11 15h.01" />
          <path d="M16 16h.01" />
          <path d="m2 16 20 6-6-20A20 20 0 0 0 2 16Z" />
          <path d="M5.71 17.11a17.04 17.04 0 0 1 11.4-11.4" />
        </svg>
      );
    case 'coffee':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 2v2" />
          <path d="M14 2v2" />
          <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
          <path d="M6 2v2" />
        </svg>
      );
    case 'bar':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 22h8" />
          <path d="M7 10h10" />
          <path d="M12 15v7" />
          <path d="M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z" />
        </svg>
      );
    case 'steak':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.5 4C11 4 7 6.5 5 10c-2 3.5-1.5 8 2.5 9.5 3.5 1.3 8.5-.5 11.5-4.5 2.5-3.3 2-8.5-1.5-10.3A6.8 6.8 0 0 0 14.5 4Z" />
          <circle cx="14" cy="10" r="2.2" />
          <path d="M8.5 14.5c1.5.5 3.5 0 4.5-1" />
        </svg>
      );
    case 'cupcake':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4a2 2 0 1 0 0-3 2 2 0 0 0 0 3Z" />
          <path d="M5 13a3 3 0 0 1 2-5.2A4 4 0 0 1 12 5a4 4 0 0 1 5 2.8A3 3 0 0 1 19 13H5Z" />
          <path d="m6 13 1.5 8h9L18 13" />
          <path d="M10 13v8" />
          <path d="M14 13v8" />
        </svg>
      );
    case 'darkkitchen':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z" />
          <path d="M6 17h12" />
        </svg>
      );
    case 'buffet':
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
          <path d="M7 2v20" />
          <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
        </svg>
      );
  }
}

const SEGMENTS: { label: string; icon: SegmentIconType }[] = [
  { label: 'Hamburgueria', icon: 'burger' },
  { label: 'Pizzaria', icon: 'pizza' },
  { label: 'Cafeteria', icon: 'coffee' },
  { label: 'Bar & Pub', icon: 'bar' },
  { label: 'Churrascaria', icon: 'steak' },
  { label: 'Doceria', icon: 'cupcake' },
  { label: 'Dark Kitchen', icon: 'darkkitchen' },
  { label: 'Restaurante', icon: 'buffet' },
];

export function LandingPage() {
  const [panelUrl, setPanelUrl] = useState('/login');

  useEffect(() => {
    let active = true;
    async function checkActiveSession() {
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session && !data.session.user.is_anonymous) {
          const { data: members } = await supabase
            .from('restaurant_members')
            .select('restaurant_id, role, active')
            .eq('active', true);
          if (members && members.length > 0) {
            const target = members.find((m) => m.role === 'admin') || members[0];
            const { data: rest } = await supabase
              .from('restaurants')
              .select('slug, active')
              .eq('id', target.restaurant_id)
              .eq('active', true)
              .maybeSingle();
            if (active && rest?.slug) {
              setPanelUrl(target.role === 'waiter' ? `/${rest.slug}/garcom` : `/${rest.slug}/admin`);
            }
          }
        }
      } catch {
        // ignora erro silencioso
      }
    }
    void checkActiveSession();
    return () => {
      active = false;
    };
  }, []);

  const [darkTheme, setDarkTheme] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const saved = window.localStorage.getItem('elozi_public_theme_preference');
      if (saved === 'dark') return true;
      if (saved === 'light') return false;
    } catch {
      // ignore
    }
    return (
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      document.documentElement.classList.contains('dark') ||
      false
    );
  });

  useEffect(() => {
    if (typeof document !== 'undefined') {
      const mode = darkTheme ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', mode);
      document.documentElement.classList.toggle('dark', darkTheme);
      try {
        window.localStorage.setItem('elozi_public_theme_preference', mode);
      } catch {
        // ignore
      }
    }
  }, [darkTheme]);

  const demoMenuUrl = typeof window === 'undefined'
    ? '/noma/cardapio'
    : new URL('/noma/cardapio', window.location.origin).toString();

  return (
    <div
      className={`landing-page min-h-screen flex flex-col justify-between transition-colors duration-200 overflow-x-hidden ${darkTheme
        ? 'dark bg-[#0c0d0e] bg-none text-zinc-100'
        : 'bg-[#FAF7F2] bg-[url(\'/landing/fundo.png\')] bg-cover bg-center bg-no-repeat text-zinc-900'
        }`}
    >
      <a className="landing-skip-link" href="#main-content">Pular para o conteúdo</a>
      {/* HEADER */}
      <header className="w-full max-w-[1600px] mx-auto px-5 sm:px-10 pt-5 pb-2 flex items-center justify-between relative z-30">
        <Link to="/" className="group flex items-center select-none">
          <img
            src="/landing/Eloozi.png"
            alt="Eloozi"
            width={635}
            height={214}
            className={`h-11 sm:h-12 w-auto object-contain transition-[filter] ${
              darkTheme ? 'brightness-0 invert' : ''
            }`}
          />
        </Link>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setDarkTheme((prev) => !prev)}
            aria-label="Alternar tema"
            aria-pressed={darkTheme}
            className={`w-10 h-10 rounded-full border flex items-center justify-center transition-colors ${darkTheme
              ? 'border-[#E51E25]/40 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:border-[#E51E25]/60'
              : 'border-[#E51E25]/35 bg-[#FAF7F2]/80 text-zinc-700 hover:bg-white hover:border-[#E51E25]/60 shadow-2xs'
              }`}
          >
            {darkTheme ? <IconMoon className="w-4 h-4" /> : <IconSun className="w-4 h-4" />}
          </button>

          <Link
            to={panelUrl}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#E51E25] hover:bg-red-700 !text-white text-white hover:!text-white hover:text-white dark:!text-white dark:text-white font-semibold text-sm px-6 py-2.5 shadow-sm transition-colors"
          >
            <span className="!text-white text-white">Entrar</span>
            <span aria-hidden="true" className="text-xs leading-none !text-white text-white">
              ↗
            </span>
          </Link>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main id="main-content" className="flex-1 w-full max-w-[1600px] mx-auto px-5 sm:px-10 pt-2 pb-4 flex flex-col justify-between gap-6">
        {/* HERO */}
        <section className="grid grid-cols-1 lg:grid-cols-12 items-center gap-6 lg:gap-2">
          {/* Coluna Esquerda (Texto) */}
          <div className="lg:col-span-5 flex flex-col items-start text-left relative z-20">
            {/* Badge Superior */}
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs sm:text-[13px] font-bold mb-4 ${darkTheme
                ? 'border-red-500/50 bg-red-950/30 text-red-200'
                : 'border-[#E51E25]/60 bg-white/55 text-zinc-800'
                }`}
            >
              <IconZap className="w-3.5 h-3.5 text-[#E51E25]" />
              <span>Gestão &amp; Cardápio Digital em Tempo Real</span>
            </div>

            {/* Título H1 — 60px no desktop com quebra exata */}
            <h1
              className={`text-[38px] sm:text-[48px] lg:text-[60px] leading-none font-extrabold tracking-[-2px] ${darkTheme ? 'text-white' : 'text-[#18181B]'
                }`}
              style={{ fontSize: 'clamp(38px, 3.6vw, 60px)', lineHeight: 1, textWrap: 'balance' }}
            >
              O ecossistema<br />
              completo para<br />
              restaurantes:<br />
              <span className="text-[#E51E25] whitespace-nowrap">da mesa à cozinha</span>
            </h1>

            {/* Subtítulo — centralizado no H1 */}
            <p
              className={`mt-4 text-sm sm:text-[15.5px] leading-[1.5] max-w-[460px] text-left ${darkTheme ? 'text-zinc-300' : 'text-zinc-600'
                }`}
            >
              Cardápio QR Code com autoatendimento, KDS de cozinha em tempo real, controle de salão
              para garçons e relatórios de turno automáticos. Tudo em um só lugar.
            </p>

            {/* CTAs Lado a Lado */}
            <div className="mt-6 flex flex-wrap items-center gap-3.5">
              <Link
                to="/criar-conta"
                className="inline-flex items-center justify-center gap-2.5 rounded-full bg-[#E51E25] hover:bg-red-700 !text-white text-white hover:!text-white hover:text-white dark:!text-white dark:text-white font-bold text-sm sm:text-[15px] px-6 py-3.5 shadow-md shadow-red-600/20 transition-[background-color,box-shadow,transform]"
              >
                <span className="!text-white text-white">Começar Teste Grátis (7 dias)</span>
                <span aria-hidden="true" className="!text-white text-white text-base leading-none">
                  →
                </span>
              </Link>

              <Link
                to={panelUrl}
                className={`inline-flex items-center justify-center rounded-full border font-bold text-sm sm:text-[15px] px-7 py-3.5 transition-colors ${darkTheme
                  ? 'border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800'
                  : 'border-zinc-400/90 bg-white/40 text-zinc-900 hover:bg-white/80'
                  }`}
              >
                Acessar Painel
              </Link>
            </div>

            {/* Microcopy abaixo dos botões */}
            <div
              className={`mt-3.5 inline-flex items-center gap-2 text-xs sm:text-[12.5px] font-medium ${darkTheme ? 'text-zinc-400' : 'text-zinc-600'
                }`}
            >
              <IconShieldCheck className="w-4 h-4 text-zinc-700 dark:text-zinc-300" />
              <span>7 dias para testar</span>
              <span>•</span>
              <span>Sem compromisso</span>
            </div>
          </div>

          {/* Coluna Direita — Composição dos 3 Dispositivos em Destaque Amplo */}
          <div className="lg:col-span-7 relative flex items-center justify-center lg:justify-end min-h-[300px] sm:min-h-[400px] lg:min-h-[470px] xl:min-h-[530px] select-none">
            {/* Linhas orbitais vermelhas sutis ao fundo (como na referência) */}
            {!darkTheme && (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute -top-32 right-0 w-[110%] h-[380px] z-0 opacity-45"
                viewBox="0 0 800 320"
                fill="none"
              >
                <path
                  d="M110 -20 C 70 110, 180 210, 340 160 C 500 110, 620 20, 790 25"
                  stroke="#E51E25"
                  strokeWidth="1"
                />
              </svg>
            )}

            {/* Container proporcional dos 3 aparelhos — Ampliado no desktop do texto à borda direita */}
            <div className="landing-device-stage relative w-full max-w-[760px] lg:max-w-[1600px] xl:max-w-[1600px] lg:-ml-8 xl:-ml-14 2xl:-ml-20 flex items-end justify-center pb-1 lg:-translate-x-8 xl:-translate-x-12">
              {/* 2. Porcentagem do Notebook Central (linha ~316) */}
              <div className="landing-device landing-device--laptop relative z-10 w-[90%] xl:w-[100%] ml-[5%]">
                <img
                  src="/landing/preview-dashboard.png"
                  alt="Painel administrativo Eloozi aberto no notebook"
                  width={1362}
                  height={784}
                  className="w-full h-auto object-contain drop-shadow-[0_24px_45px_rgba(0,0,0,0.28)]"
                  loading="eager"
                />
              </div>

              {/* Smartphone Esquerdo (Cardápio Claro) — sobreposto à borda esquerda do Notebook */}
              <div className="landing-device landing-device--menu absolute left-0 sm:left-[-5%] -bottom-4 z-20 w-[24%] sm:w-[23%] lg:w-[23.5%] max-w-[210px] xl:max-w-[245px] transition-transform duration-300 hover:-translate-y-1">
                <img
                  src="/landing/preview-cardapio.png"
                  alt="Cardápio digital Eloozi aberto em um smartphone"
                  width={694}
                  height={1304}
                  className="w-full h-auto object-contain drop-shadow-[0_20px_32px_rgba(0,0,0,0.30)]"
                  loading="eager"
                />
              </div>

              {/* Smartphone Direito (Garçom Escuro) — sobreposto à borda direita do Notebook */}
              <div className="landing-device landing-device--staff absolute right-0 sm:right-[-8%] -bottom-2 z-20 w-[24%] sm:w-[23%] lg:w-[23.5%] max-w-[210px] xl:max-w-[245px] transition-transform duration-300 hover:-translate-y-1">
                <img
                  src="/landing/preview-garcom.png"
                  alt="Aplicativo de atendimento Eloozi aberto em um smartphone"
                  width={769}
                  height={1387}
                  className="w-full h-auto object-contain drop-shadow-[0_20px_32px_rgba(0,0,0,0.35)]"
                  loading="eager"
                />
              </div>
            </div>
          </div>
        </section>

        {/* SEÇÃO INFERIOR — 3 PAINÉIS ALINHADOS (PROPORÇÃO 5 : 3.5 : 3.5) */}
        <section className="grid grid-cols-1 lg:grid-cols-[5fr_3.5fr_3.5fr] gap-4 items-stretch relative z-30">
          {/* BLOCO 1 — Restaurantes atendidos */}
          <div
            className={`p-5 flex flex-col justify-between ${darkTheme
              ? 'rounded-2xl border border-zinc-800 bg-zinc-900/80'
              : 'bg-transparent border-none shadow-none'
              }`}
          >
            <div>
              <h2
                className={`text-base sm:text-[17px] font-bold tracking-tight leading-snug ${darkTheme ? 'text-white' : 'text-zinc-900'
                  }`}
              >
                <span className="landing-panel-heading"><IconStore className="w-6 h-6 text-[#E51E25]" />Segmentos atendidos</span>
              </h2>
              <p className={`text-xs mt-0.5 ${darkTheme ? 'text-zinc-400' : 'text-zinc-500'}`}>
                Diversos segmentos, a mesma qualidade de gestão.
              </p>
            </div>

            <div className="mt-3.5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {SEGMENTS.map((seg) => (
                <div
                  key={seg.label}
                  className="bg-[#18191C] hover:bg-zinc-800 text-white rounded-xl px-2 h-12 min-h-[48px] w-full flex items-center gap-2 shadow-2xs transition-colors overflow-hidden"
                >
                  <span className="shrink-0 flex items-center justify-center text-[#E51E25]">
                    <SegmentIcon type={seg.icon} className="w-4 h-4 shrink-0 text-[#E51E25]" />
                  </span>
                  <span className="text-[11px] sm:text-xs font-medium text-zinc-100 leading-tight whitespace-nowrap">
                    {seg.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* BLOCO 2 — Soluções */}
          <div
            className={`p-5 flex flex-col justify-between ${darkTheme
              ? 'rounded-2xl border border-zinc-800 bg-zinc-900/80'
              : 'bg-transparent border-none shadow-none'
              }`}
          >
            <div>
              <h2
                className={`text-base sm:text-[17px] font-bold tracking-tight leading-snug ${darkTheme ? 'text-white' : 'text-zinc-900'
                  }`}
              >
                <span className="landing-panel-heading"><IconLayers className="w-6 h-6 text-[#E51E25]" />Nossas soluções</span>
              </h2>
              <p className={`text-xs mt-0.5 ${darkTheme ? 'text-zinc-400' : 'text-zinc-500'}`}>
                Tudo o que você precisa para uma operação eficiente.
              </p>
            </div>

            <ul
              className={`mt-2.5 divide-y ${darkTheme ? 'divide-zinc-800' : 'divide-zinc-200/80'
                }`}
            >
              <li className="py-1.5 first:pt-1 last:pb-0 flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full bg-[#E51E25] !text-white text-white flex items-center justify-center shrink-0">
                  <IconCheck className="w-2.5 h-2.5 !text-white text-white" />
                </span>
                <span className={`text-xs sm:text-[13px] font-bold ${darkTheme ? 'text-zinc-100' : 'text-zinc-800'}`}>
                  PDV Balcão e Caixa
                </span>
              </li>
              <li className="py-1.5 flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full bg-[#E51E25] !text-white text-white flex items-center justify-center shrink-0">
                  <IconCheck className="w-2.5 h-2.5 !text-white text-white" />
                </span>
                <span className={`text-xs sm:text-[13px] font-bold ${darkTheme ? 'text-zinc-100' : 'text-zinc-800'}`}>
                  Garçom Digital
                </span>
              </li>
              <li className="py-1.5 flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full bg-[#E51E25] !text-white text-white flex items-center justify-center shrink-0">
                  <IconCheck className="w-2.5 h-2.5 !text-white text-white" />
                </span>
                <span className={`text-xs sm:text-[13px] font-medium ${darkTheme ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  Comanda Eletrônica
                </span>
              </li>
              <li className="py-1.5 flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full bg-[#E51E25] !text-white text-white flex items-center justify-center shrink-0">
                  <IconCheck className="w-2.5 h-2.5 !text-white" />
                </span>
                <span className={`text-xs sm:text-[13px] font-medium ${darkTheme ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  Pedidos pelo cardápio QR Code
                </span>
              </li>
              <li className="py-1.5 flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full bg-[#E51E25] !text-white text-white flex items-center justify-center shrink-0">
                  <IconCheck className="w-2.5 h-2.5 !text-white text-white" />
                </span>
                <span className={`text-xs sm:text-[13px] font-medium ${darkTheme ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  Painel KDS{' '}
                  <span className={darkTheme ? 'text-zinc-400 font-normal' : 'text-zinc-500 font-normal'}>
                    (para cozinha)
                  </span>
                </span>
              </li>
              <li className="py-1.5 last:pb-0 flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full bg-[#E51E25] !text-white text-white flex items-center justify-center shrink-0">
                  <IconCheck className="w-2.5 h-2.5 !text-white text-white" />
                </span>
                <span className={`text-xs sm:text-[13px] font-bold ${darkTheme ? 'text-zinc-100' : 'text-zinc-800'}`}>
                  Menu Digital
                </span>
              </li>
              <li className="py-1.5 last:pb-0 flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full bg-[#E51E25] !text-white text-white flex items-center justify-center shrink-0">
                  <IconCheck className="w-2.5 h-2.5 !text-white" />
                </span>
                <span className={`text-xs sm:text-[13px] font-medium ${darkTheme ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  Chamados para a equipe
                </span>
              </li>
            </ul>
          </div>

          {/* BLOCO 3 — QR Code */}
          <div
            className={`p-5 flex items-center justify-between gap-4 ${darkTheme
              ? 'rounded-2xl border border-zinc-800 bg-zinc-900/80'
              : 'bg-transparent border-none shadow-none'
              }`}
          >
            <div className="flex-1 min-w-0">
              <div className="w-5 h-[2.5px] bg-[#E51E25] mb-2.5 rounded-full" />
              <h2
                className={`text-sm sm:text-[15.5px] font-bold leading-snug ${darkTheme ? 'text-white' : 'text-zinc-900'
                  }`}
              >
                <span className="landing-panel-heading"><IconScan className="w-6 h-6 text-[#E51E25]" />Conheça na prática!</span>
              </h2>
              <p
                className={`mt-2 text-xs leading-relaxed ${darkTheme ? 'text-zinc-400' : 'text-zinc-500'
                  }`}
              >
                Aponte a câmera para o QR Code e experimente o cardápio digital da Eloozi.
              </p>
            </div>

            <div
              className={`landing-qr-frame shrink-0 rounded-2xl p-2 border ${darkTheme ? 'bg-zinc-800/60 border-zinc-700' : 'bg-[#EFECE6] border-zinc-200/90'
                }`}
            >
              <Link
                to="/noma/cardapio"
                aria-label={`Abrir o cardápio de demonstração do NOMA em ${demoMenuUrl}`}
                className="bg-white rounded-xl p-2.5 shadow-2xs flex items-center justify-center"
              >
                <QRCodeSVG
                  value={demoMenuUrl}
                  size={98}
                  bgColor="#FFFFFF"
                  fgColor="#18181B"
                  level="M"
                  title="Abrir o cardápio de demonstração do NOMA"
                />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* FOOTER — FAIXA ESCURA FINAL */}
      <footer className="w-full bg-[#1C1E21] text-zinc-300 border-t border-zinc-800 mt-3">
        <div className="max-w-[1600px] mx-auto px-5 sm:px-10 py-3.5 flex flex-col md:flex-row items-center justify-between gap-3 text-xs">
          {/* Esquerda */}
          <div className="flex items-center gap-3.5">
            <img
              src="/landing/Eloozi.png"
              alt="Eloozi"
              width={635}
              height={214}
              className="h-7 sm:h-8 w-auto object-contain brightness-0 invert"
            />
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-300">Experiências Digitais para seu Negócio</span>
          </div>

          {/* Direita */}
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-5 text-zinc-200">
            <div className="inline-flex items-center gap-2">
              <IconShieldCheck className="w-4 h-4 text-zinc-200" />
              <span>Seguro e confiável</span>
            </div>

            <span className="hidden sm:inline text-zinc-600">|</span>

            <div className="inline-flex items-center gap-2">
              <IconCloud className="w-4 h-4 text-zinc-200" />
              <span>Acesso em qualquer lugar</span>
            </div>

            <span className="hidden sm:inline text-zinc-600">|</span>

            <div className="inline-flex items-center gap-2">
              <IconHeadset className="w-4 h-4 text-zinc-200" />
              <span>Suporte especializado</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
