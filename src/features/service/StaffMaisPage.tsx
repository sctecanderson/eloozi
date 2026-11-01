import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import type { StaffAccess, AuthPasswordCapabilities } from '../auth/staffAuth';
import {
  inspectUserPasswordCapabilities,
  signOutStaff,
  updateAuthenticatedUserPassword,
  updateStaffDisplayName,
} from '../auth/staffAuth';
import {
  getStaffInvitationErrorMessage,
  MIN_NEW_PASSWORD_LENGTH,
  validateNewPassword,
} from '../auth/staffAuthErrors';
import { useTheme } from '../theme/ThemeContext';
import { isSoundEnabled, toggleSoundEnabled } from '../../lib/soundAlerts';
import { supabase } from '../../lib/supabase';

function getInitials(name: string): string {
  if (!name.trim()) return 'EQ';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function StaffMaisPage() {
  const { restaurantSlug = '' } = useParams<{ restaurantSlug: string }>();
  const access = useOutletContext<StaffAccess>();
  const navigate = useNavigate();
  const { theme: themeMode, toggleTheme } = useTheme();

  // Estados do usuário e dados da equipe
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState(access.displayName || '');
  const [initialDisplayName, setInitialDisplayName] = useState(access.displayName || '');
  const [isAccountActive, setIsAccountActive] = useState(true);

  // Estados de salvamento e feedback
  const [savingName, setSavingName] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Estados de som sincronizados com o app
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled());

  // Estados para modal de logout e toasts
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Estados da seção Segurança -> Alterar senha
  const [capabilities, setCapabilities] = useState<AuthPasswordCapabilities>({
    hasEmailIdentity: false,
    hasGoogleIdentity: false,
  });
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [needsCurrentPassword, setNeedsCurrentPassword] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const actingPassword = useRef(false);

  const clearPasswordFields = useCallback(() => {
    setNewPassword('');
    setConfirmPassword('');
    setCurrentPassword('');
  }, []);

  const closePasswordForm = useCallback(() => {
    setShowPasswordForm(false);
    setNeedsCurrentPassword(false);
    clearPasswordFields();
  }, [clearPasswordFields]);

  // Carregar dados de autenticação e restaurante
  useEffect(() => {
    let active = true;

    async function loadUserData() {
      try {
        const { data } = await supabase.auth.getUser();
        if (active && data?.user) {
          if (data.user.email) setEmail(data.user.email);
          const metaName = (data.user.user_metadata?.full_name as string) || (data.user.user_metadata?.name as string) || '';
          if (metaName) setFullName(metaName);
          setCapabilities(inspectUserPasswordCapabilities(data.user));
        }

        if (active && access?.memberId) {
          const { data: member } = await supabase
            .from('restaurant_members')
            .select('display_name, active')
            .eq('id', access.memberId)
            .maybeSingle();

          if (active && member) {
            if (member.display_name !== undefined && member.display_name !== null) {
              setDisplayName(member.display_name);
              setInitialDisplayName(member.display_name);
            }
            if (typeof member.active === 'boolean') {
              setIsAccountActive(member.active);
            }
          }
        }
      } catch {
        // Silencioso, mantém defaults
      }
    }

    void loadUserData();

    return () => {
      active = false;
    };
  }, [access?.memberId]);

  // Sincronização do estado de som
  useEffect(() => {
    function handleSoundChange(e: Event) {
      const customEvent = e as CustomEvent<{ enabled: boolean }>;
      if (typeof customEvent.detail?.enabled === 'boolean') {
        setSoundOn(customEvent.detail.enabled);
      } else {
        setSoundOn(isSoundEnabled());
      }
    }

    window.addEventListener('elozi:sound-setting-changed', handleSoundChange);
    return () => {
      window.removeEventListener('elozi:sound-setting-changed', handleSoundChange);
    };
  }, []);

  // Notificação "Em breve" para recursos não implementados
  const handleFeatureSoon = useCallback((featureName: string) => {
    setToastMessage(`A funcionalidade "${featureName}" estará disponível em breve.`);
    setTimeout(() => {
      setToastMessage((curr) => (curr?.includes(featureName) ? null : curr));
    }, 3500);
  }, []);

  // Ação unificada para salvar nome de atendimento
  const hasChanges = useMemo(() => {
    return displayName.trim() !== initialDisplayName.trim();
  }, [displayName, initialDisplayName]);

  const handleSaveDisplayName = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!hasChanges || savingName) return;

      setFeedback(null);
      setSavingName(true);

      try {
        const updated = await updateStaffDisplayName(restaurantSlug, displayName);
        const resolvedName = updated || displayName.trim();
        setDisplayName(resolvedName);
        setInitialDisplayName(resolvedName);
        setFeedback({ type: 'success', message: 'Nome de atendimento salvo com sucesso!' });
        setTimeout(() => setFeedback(null), 3500);
      } catch (err) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Falha ao salvar nome. Tente novamente.',
        });
      } finally {
        setSavingName(false);
      }
    },
    [displayName, hasChanges, restaurantSlug, savingName]
  );

  // Confirmação e execução de logout
  async function handleConfirmLogout() {
    setLoggingOut(true);
    try {
      await signOutStaff();
      navigate(`/${restaurantSlug}/acesso`, { replace: true });
    } catch {
      setLoggingOut(false);
      setShowLogoutModal(false);
      setToastMessage('Falha ao encerrar a sessão. Tente novamente.');
    }
  }

  // Alterar senha da conta autenticada
  async function handleUpdatePassword(e: React.FormEvent) {
    e.preventDefault();
    if (actingPassword.current || updatingPassword) return;

    const check = validateNewPassword(newPassword, confirmPassword);
    if (!check.valid) {
      setPasswordFeedback({
        type: 'error',
        message: check.error || 'Confira a nova senha e a confirmação.',
      });
      return;
    }

    if (needsCurrentPassword && capabilities.hasEmailIdentity && !currentPassword) {
      setPasswordFeedback({
        type: 'error',
        message: 'Informe sua senha atual para confirmar a alteração.',
      });
      return;
    }

    actingPassword.current = true;
    setUpdatingPassword(true);
    setPasswordFeedback(null);

    try {
      const res = await updateAuthenticatedUserPassword({
        newPassword,
        confirmPassword,
        currentPassword: currentPassword || undefined,
      });

      if (res.requiresCurrentPassword) {
        setNeedsCurrentPassword(true);
        clearPasswordFields();
        if (capabilities.hasGoogleIdentity && !capabilities.hasEmailIdentity) {
          setPasswordFeedback({
            type: 'error',
            message: 'Sua sessão precisa ser renovada antes de definir uma senha. Saia e entre novamente.',
          });
        } else {
          setPasswordFeedback({
            type: 'error',
            message: 'Por segurança, informe sua senha atual para concluir a alteração.',
          });
        }
        return;
      }

      closePasswordForm();
      setPasswordFeedback({
        type: 'success',
        message: 'Senha atualizada com sucesso!',
      });
    } catch (err) {
      clearPasswordFields();
      setPasswordFeedback({
        type: 'error',
        message: getStaffInvitationErrorMessage(err),
      });
    } finally {
      actingPassword.current = false;
      setUpdatingPassword(false);
    }
  }

  const isDark = themeMode === 'dark';
  const resolvedDisplayName = displayName.trim() || initialDisplayName.trim() || 'Não definido';
  const headerName = fullName || resolvedDisplayName || email.split('@')[0] || 'Colaborador';
  const initials = getInitials(headerName);

  return (
    <div className="w-full space-y-4 pb-12 animate-in fade-in duration-200">
      {/* Toast informativo */}
      {toastMessage && (
        <div
          role="status"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[90%] bg-zinc-900 text-white text-xs font-semibold py-2.5 px-4 rounded-2xl shadow-xl border border-zinc-700/60 flex items-center justify-between"
        >
          <span>{toastMessage}</span>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="ml-2 text-zinc-400 hover:text-white p-1"
            aria-label="Fechar aviso"
          >
            ✕
          </button>
        </div>
      )}

      {/* Título da tela */}
      <div className="mb-2">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          Perfil do Funcionário
        </h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          Informações da sua conta na equipe.
        </p>
      </div>

      {/* 1. Card de Identificação */}
      <div className="rounded-3xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 p-4 shadow-sm flex items-center justify-between gap-3">
        <div className="flex items-center gap-3.5 min-w-0">
          {/* Avatar com Iniciais */}
          <div className="w-14 h-14 rounded-full bg-[#F5ECE5] dark:bg-zinc-800 flex items-center justify-center text-[#7C2D12] dark:text-amber-400 font-bold text-xl shrink-0 border border-amber-900/10">
            {initials}
          </div>

          <div className="min-w-0">
            <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100 truncate">
              {headerName}
            </h2>
            <div className="mt-0.5">
              <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300">
                {access.role === 'admin' ? 'Administrador' : 'Garçom'}
              </span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 truncate">
              Nome de atendimento:{' '}
              <strong className="text-zinc-800 dark:text-zinc-200 font-semibold">
                {resolvedDisplayName}
              </strong>
            </p>
          </div>
        </div>
      </div>

      {/* 2. Card da Conta de Acesso */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 p-4 shadow-sm flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
            {/* Ícone Envelope */}
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="20" height="16" x="2" y="4" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
              Conta de acesso
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              E-mail utilizado no login da equipe.
            </p>
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-1 break-all">
              {email || 'Carregando...'}
            </p>
          </div>
        </div>

        {/* Badge de status real da conta */}
        <div className="shrink-0">
          {isAccountActive ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Ativa
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
              Inativa
            </span>
          )}
        </div>
      </div>

      {/* 3. Card Nome visível para o cliente */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 p-4 shadow-sm space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
            {/* Ícone Usuário */}
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
              Nome visível para o cliente
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Como você será identificado pelo cliente na mesa.
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveDisplayName} className="space-y-2">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              id="staff-mais-display-name"
              type="text"
              maxLength={40}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ex: Anderson Alves"
              className="flex-1 rounded-xl border border-stone-300 dark:border-zinc-700 bg-stone-50/50 dark:bg-zinc-800/50 px-3.5 py-2.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#8A3A1B]/30 focus:border-[#8A3A1B]"
            />
            <button
              type="submit"
              disabled={!hasChanges || savingName}
              className="px-4 py-2.5 rounded-xl bg-[#7C2D12] hover:bg-[#6A260F] text-white text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap cursor-pointer shadow-xs active:scale-95"
            >
              {savingName ? 'Salvando...' : 'Salvar nome'}
            </button>
          </div>

          {feedback && (
            <p
              role={feedback.type === 'error' ? 'alert' : 'status'}
              className={`text-xs font-semibold px-3 py-2 rounded-lg border animate-in fade-in duration-200 ${
                feedback.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                  : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
              }`}
            >
              {feedback.message}
            </p>
          )}
        </form>
      </div>

      {/* 4. Card Preferências Rápidas */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 p-4 shadow-sm space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
            {/* Ícone Engrenagem */}
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
              Preferências rápidas
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Ajuste como o app se comporta no seu dispositivo.
            </p>
          </div>
        </div>

        <div className="space-y-3 pt-1">
          {/* Linha Modo Noturno */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <svg
                className="w-5 h-5 text-zinc-500 dark:text-zinc-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
              <div>
                <span className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  Modo noturno
                </span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                  Deixa o app mais escuro para uso noturno.
                </span>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={isDark}
              onClick={toggleTheme}
              className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#8A3A1B]/40 ${
                isDark ? 'bg-[#7C2D12]' : 'bg-stone-300 dark:bg-zinc-700'
              }`}
              aria-label="Alternar modo noturno"
            >
              <span
                className={`block w-5 h-5 rounded-full bg-white shadow-md transform transition-transform ${
                  isDark ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Linha Sons de Notificação */}
          <div className="flex items-center justify-between py-1 border-t border-stone-100 dark:border-zinc-800/80 pt-3">
            <div className="flex items-center gap-3">
              <svg
                className="w-5 h-5 text-zinc-500 dark:text-zinc-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
              <div>
                <span className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  Sons de notificação
                </span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                  Reproduz sons para novos chamados e alertas.
                </span>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={soundOn}
              onClick={() => {
                const next = toggleSoundEnabled();
                setSoundOn(next);
              }}
              className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#8A3A1B]/40 ${
                soundOn ? 'bg-[#7C2D12]' : 'bg-stone-300 dark:bg-zinc-700'
              }`}
              aria-label="Alternar sons de notificação"
            >
              <span
                className={`block w-5 h-5 rounded-full bg-white shadow-md transform transition-transform ${
                  soundOn ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* 4b. Card Segurança */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 p-4 shadow-sm space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
              {/* Ícone Cadeado */}
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                Segurança
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {capabilities.hasGoogleIdentity && !capabilities.hasEmailIdentity
                  ? 'Conta vinculada ao Google. Você pode definir uma senha para entrar também com e-mail.'
                  : 'Gerencie a senha de acesso da sua conta.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={updatingPassword}
            onClick={() => {
              setPasswordFeedback(null);
              if (showPasswordForm) {
                closePasswordForm();
              } else {
                setShowPasswordForm(true);
              }
            }}
            className="px-3.5 py-2 rounded-xl border border-stone-300 dark:border-zinc-700 text-xs font-bold text-zinc-800 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            {showPasswordForm ? 'Cancelar' : 'Alterar senha'}
          </button>
        </div>

        {passwordFeedback && (
          <p
            role={passwordFeedback.type === 'error' ? 'alert' : 'status'}
            className={`text-xs font-semibold px-3 py-2 rounded-lg border animate-in fade-in duration-200 ${
              passwordFeedback.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
            }`}
          >
            {passwordFeedback.message}
          </p>
        )}

        {showPasswordForm && (
          <form onSubmit={handleUpdatePassword} className="space-y-3 pt-2 border-t border-stone-100 dark:border-zinc-800/80">
            <fieldset disabled={updatingPassword} className="space-y-3">
              {needsCurrentPassword && capabilities.hasEmailIdentity && (
                <div>
                  <label
                    htmlFor="staff-mais-current-password"
                    className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1"
                  >
                    Senha atual
                  </label>
                  <input
                    id="staff-mais-current-password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Digite sua senha atual"
                    className="w-full rounded-xl border border-stone-300 dark:border-zinc-700 bg-stone-50/50 dark:bg-zinc-800/50 px-3.5 py-2.5 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#8A3A1B]/30 focus:border-[#8A3A1B]"
                  />
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="staff-mais-new-password"
                    className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1"
                  >
                    Nova senha
                  </label>
                  <input
                    id="staff-mais-new-password"
                    type="password"
                    required
                    minLength={MIN_NEW_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={`Mínimo de ${MIN_NEW_PASSWORD_LENGTH} caracteres`}
                    className="w-full rounded-xl border border-stone-300 dark:border-zinc-700 bg-stone-50/50 dark:bg-zinc-800/50 px-3.5 py-2.5 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#8A3A1B]/30 focus:border-[#8A3A1B]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="staff-mais-confirm-password"
                    className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1"
                  >
                    Confirmar nova senha
                  </label>
                  <input
                    id="staff-mais-confirm-password"
                    type="password"
                    required
                    minLength={MIN_NEW_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repita a nova senha"
                    className="w-full rounded-xl border border-stone-300 dark:border-zinc-700 bg-stone-50/50 dark:bg-zinc-800/50 px-3.5 py-2.5 text-sm font-medium text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#8A3A1B]/30 focus:border-[#8A3A1B]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closePasswordForm}
                  disabled={updatingPassword}
                  className="px-4 py-2 rounded-xl border border-stone-300 dark:border-zinc-700 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Fechar
                </button>
                <button
                  type="submit"
                  disabled={updatingPassword}
                  className="px-4 py-2 rounded-xl bg-[#7C2D12] hover:bg-[#6A260F] text-white text-xs font-bold transition-all disabled:opacity-40 cursor-pointer shadow-xs"
                >
                  {updatingPassword ? 'Salvando senha...' : 'Salvar nova senha'}
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </div>

      {/* 5. Card Ações da Conta */}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 p-4 shadow-sm space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
            {/* Ícone Configurações da Conta */}
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
              Ações da conta
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Acesse outras funcionalidades do sistema.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
          {/* Histórico */}
          <button
            type="button"
            onClick={() => navigate(`/${restaurantSlug}/equipe/historico?aba=atendimentos`)}
            className="flex items-center justify-between p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/60 hover:bg-[#FAF4EE] dark:hover:bg-zinc-800 border border-stone-200/60 dark:border-zinc-700/60 transition-all text-left group cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-white dark:bg-zinc-700 text-stone-700 dark:text-zinc-300 flex items-center justify-center shrink-0 shadow-xs">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <div>
                <span className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors">
                  Histórico
                </span>
                <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">
                  Ver atendimentos realizados
                </span>
              </div>
            </div>
            <svg
              className="w-4 h-4 text-zinc-400 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* Listagem de Comandas */}
          <button
            type="button"
            onClick={() => navigate(`/${restaurantSlug}/equipe/historico?aba=comandas`)}
            className="flex items-center justify-between p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/60 hover:bg-[#FAF4EE] dark:hover:bg-zinc-800 border border-stone-200/60 dark:border-zinc-700/60 transition-all text-left group cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-white dark:bg-zinc-700 text-stone-700 dark:text-zinc-300 flex items-center justify-center shrink-0 shadow-xs">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </div>
              <div>
                <span className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors">
                  Comandas (Histórico)
                </span>
                <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">
                  Consultar, filtrar e imprimir
                </span>
              </div>
            </div>
            <svg
              className="w-4 h-4 text-zinc-400 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* Impressoras */}
          <button
            type="button"
            onClick={() => handleFeatureSoon('Impressoras')}
            className="flex items-center justify-between p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/60 hover:bg-[#FAF4EE] dark:hover:bg-zinc-800 border border-stone-200/60 dark:border-zinc-700/60 transition-all text-left group cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-white dark:bg-zinc-700 text-stone-700 dark:text-zinc-300 flex items-center justify-center shrink-0 shadow-xs">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <rect width="12" height="8" x="6" y="14" />
                </svg>
              </div>
              <div>
                <span className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors">
                  Impressoras
                </span>
                <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">
                  Gerenciar dispositivos
                </span>
              </div>
            </div>
            <svg
              className="w-4 h-4 text-zinc-400 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* Configurações */}
          <button
            type="button"
            onClick={() => handleFeatureSoon('Configurações')}
            className="flex items-center justify-between p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/60 hover:bg-[#FAF4EE] dark:hover:bg-zinc-800 border border-stone-200/60 dark:border-zinc-700/60 transition-all text-left group cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-white dark:bg-zinc-700 text-stone-700 dark:text-zinc-300 flex items-center justify-center shrink-0 shadow-xs">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </div>
              <div>
                <span className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors">
                  Configurações
                </span>
                <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">
                  Ajustes do aplicativo
                </span>
              </div>
            </div>
            <svg
              className="w-4 h-4 text-zinc-400 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {/* Ajuda e Suporte */}
          <button
            type="button"
            onClick={() => handleFeatureSoon('Ajuda e suporte')}
            className="flex items-center justify-between p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/60 hover:bg-[#FAF4EE] dark:hover:bg-zinc-800 border border-stone-200/60 dark:border-zinc-700/60 transition-all text-left group cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-white dark:bg-zinc-700 text-stone-700 dark:text-zinc-300 flex items-center justify-center shrink-0 shadow-xs">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
              </div>
              <div>
                <span className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors">
                  Ajuda e suporte
                </span>
                <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">
                  Dúvidas e atendimento
                </span>
              </div>
            </div>
            <svg
              className="w-4 h-4 text-zinc-400 group-hover:text-[#7C2D12] dark:group-hover:text-amber-400 transition-colors shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* 6. Botões Inferiores */}
      <div className="space-y-2.5 pt-2">
        {/* Botão Salvar alterações */}
        <button
          type="button"
          onClick={() => void handleSaveDisplayName()}
          disabled={!hasChanges || savingName}
          className="w-full py-3.5 px-4 rounded-2xl bg-[#7C2D12] hover:bg-[#6A260F] text-white font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer active:scale-[0.99]"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          <span>{savingName ? 'Salvando alterações...' : 'Salvar alterações'}</span>
        </button>

        {/* Botão Sair da conta */}
        <button
          type="button"
          onClick={() => setShowLogoutModal(true)}
          className="w-full py-3 px-4 rounded-2xl border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 bg-red-50/50 dark:bg-red-950/20 hover:bg-red-100/50 dark:hover:bg-red-900/30 font-bold text-sm transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99]"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span>Sair da conta</span>
        </button>
      </div>

      {/* Modal de Confirmação de Logout */}
      {showLogoutModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-stone-200 dark:border-zinc-800 text-center space-y-4 animate-in zoom-in-95 duration-150">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400 mx-auto flex items-center justify-center">
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </div>

            <div>
              <h3 id="logout-title" className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                Sair da conta?
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Deseja realmente encerrar sua sessão neste dispositivo?
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowLogoutModal(false)}
                disabled={loggingOut}
                className="w-full py-2.5 rounded-xl border border-stone-300 dark:border-zinc-700 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-all cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmLogout}
                disabled={loggingOut}
                className="w-full py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-xs font-bold text-white transition-all shadow-xs cursor-pointer disabled:opacity-50"
              >
                {loggingOut ? 'Saindo...' : 'Sim, sair'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
