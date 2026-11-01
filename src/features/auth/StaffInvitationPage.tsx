import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { acceptInvite } from '../admin/staffManagement';
import {
    inspectUserPasswordCapabilities,
    updateAuthenticatedUserPassword,
    type AuthPasswordCapabilities,
} from './staffAuth';
import {
    getStaffInvitationErrorMessage,
    MIN_NEW_PASSWORD_LENGTH,
    validateNewPassword,
} from './staffAuthErrors';

export function StaffInvitationPage() {
    const [params] = useSearchParams();
    const token = params.get('token') || '';
    return <Invitation key={token} token={token} />;
}

function Invitation({ token }: { token: string }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [mode, setMode] = useState<'login' | 'signup'>('login');
    const [account, setAccount] = useState<string | null>(null);
    const [capabilities, setCapabilities] = useState<AuthPasswordCapabilities>({
        hasEmailIdentity: false,
        hasGoogleIdentity: false,
    });
    const [checking, setChecking] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [slug, setSlug] = useState('');

    // Seção opcional "Definir ou alterar minha senha" para sessões autenticadas
    const [showPasswordForm, setShowPasswordForm] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [newConfirmPassword, setNewConfirmPassword] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [needsCurrentPassword, setNeedsCurrentPassword] = useState(false);

    const acting = useRef(false);

    function clearSensitiveFields() {
        setPassword('');
        setConfirmPassword('');
        setNewPassword('');
        setNewConfirmPassword('');
        setCurrentPassword('');
    }

    function closePasswordForm() {
        setShowPasswordForm(false);
        setNeedsCurrentPassword(false);
        clearSensitiveFields();
    }

    useEffect(() => {
        let disposed = false;
        void supabase.auth.getSession().then(({ data }) => {
            if (!disposed) {
                const user = data.session && !data.session.user.is_anonymous ? data.session.user : null;
                setAccount(user?.email || null);
                setCapabilities(inspectUserPasswordCapabilities(user));
                setChecking(false);
            }
        }).catch(() => {
            if (!disposed) {
                setError('Não foi possível verificar a conta. Recarregue a página.');
                setChecking(false);
            }
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (!disposed) {
                const user = session && !session.user.is_anonymous ? session.user : null;
                setAccount(user?.email || null);
                setCapabilities(inspectUserPasswordCapabilities(user));
                setChecking(false);
            }
        });

        return () => {
            disposed = true;
            subscription.unsubscribe();
        };
    }, []);

    async function run(action: () => Promise<void>) {
        if (acting.current) return;
        acting.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await action();
        } catch (e) {
            setError(getStaffInvitationErrorMessage(e));
        } finally {
            acting.current = false;
            setBusy(false);
            setPassword('');
            setConfirmPassword('');
        }
    }

    if (!/^[0-9a-f]{64}$/.test(token)) {
        return (
            <main className="shell py-10">
                <h1>Convite inválido</h1>
                <p>O código do convite é inválido ou incompleto. Solicite o link correto ao administrador.</p>
            </main>
        );
    }

    return (
        <main className="mx-auto max-w-lg space-y-5 px-4 py-10">
            <h1 className="text-3xl font-semibold">Convite para a equipe</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
                Entre com o e-mail informado ao administrador para aceitar o acesso ao restaurante.
            </p>

            {error && <p role="alert" className="admin-alert error">{error}</p>}
            {notice && <p role="status" className="admin-alert success">{notice}</p>}

            {slug ? (
                <section className="admin-card space-y-3">
                    <h2 className="font-semibold text-emerald-700 dark:text-emerald-400">Acesso liberado com sucesso!</h2>
                    <p className="text-sm text-zinc-600 dark:text-zinc-300">
                        Seu vínculo com o restaurante foi confirmado pelo servidor. Você já pode acessar o painel operacional da equipe.
                    </p>
                    <Link to={`/${slug}/acesso`} className="admin-button primary mt-2 inline-block">
                        Abrir acesso da equipe
                    </Link>
                </section>
            ) : checking ? (
                <p role="status">Verificando conta…</p>
            ) : account ? (
                <section className="admin-card space-y-4">
                    <div>
                        <p>Conta conectada: <strong>{account}</strong></p>
                        <p className="text-xs text-zinc-500 mt-1">
                            Certifique-se de que este é o mesmo e-mail para o qual o convite foi gerado. Se você já possui senha cadastrada, pode aceitar o convite diretamente sem alterá-la.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <button
                            disabled={busy}
                            type="button"
                            className="admin-button primary"
                            onClick={() => void run(async () => {
                                const result = await acceptInvite(token);
                                clearSensitiveFields();
                                setSlug(result.slug);
                            })}
                        >
                            {busy ? 'Validando…' : 'Aceitar convite'}
                        </button>
                        <button
                            disabled={busy}
                            type="button"
                            className="admin-button"
                            onClick={() => {
                                setError('');
                                setNotice('');
                                if (showPasswordForm) {
                                    closePasswordForm();
                                } else {
                                    setShowPasswordForm(true);
                                }
                            }}
                        >
                            {showPasswordForm ? 'Cancelar definição de senha' : 'Definir ou alterar minha senha'}
                        </button>
                        <button
                            disabled={busy}
                            type="button"
                            className="admin-button"
                            onClick={() => void run(async () => {
                                const { error: signOutErr } = await supabase.auth.signOut({ scope: 'local' });
                                if (signOutErr) throw signOutErr;
                                closePasswordForm();
                                setAccount(null);
                            })}
                        >
                            Usar outra conta
                        </button>
                    </div>

                    {showPasswordForm && (
                        <form
                            className="admin-form border-t border-zinc-200 dark:border-zinc-800 pt-4 mt-3 space-y-3"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void run(async () => {
                                    const check = validateNewPassword(newPassword, newConfirmPassword);
                                    if (!check.valid) {
                                        throw new Error(check.error);
                                    }
                                    if (needsCurrentPassword && capabilities.hasEmailIdentity && !currentPassword) {
                                        throw new Error('Informe sua senha atual para confirmar a alteração.');
                                    }

                                    const res = await updateAuthenticatedUserPassword({
                                        newPassword,
                                        confirmPassword: newConfirmPassword,
                                        currentPassword: currentPassword || undefined,
                                    });

                                    if (res.requiresCurrentPassword) {
                                        setNeedsCurrentPassword(true);
                                        setNewPassword('');
                                        setNewConfirmPassword('');
                                        setCurrentPassword('');
                                        if (capabilities.hasGoogleIdentity && !capabilities.hasEmailIdentity) {
                                            throw new Error('Sua sessão precisa ser renovada antes de definir uma senha. Saia e entre novamente.');
                                        }
                                        throw new Error('Por segurança, informe sua senha atual para concluir a alteração.');
                                    }

                                    closePasswordForm();
                                    setNotice('Senha atualizada com sucesso na sua conta! Agora clique em "Aceitar convite" para liberar o seu acesso ao restaurante.');
                                });
                            }}
                        >
                            <h3 className="text-sm font-semibold">Definir ou alterar minha senha</h3>
                            <p className="text-xs text-zinc-500">
                                {capabilities.hasGoogleIdentity && !capabilities.hasEmailIdentity
                                    ? 'Sua conta foi conectada via Google. Você pode definir uma senha de acesso por e-mail abaixo (mínimo de 10 caracteres).'
                                    : `Escolha uma senha com pelo menos ${MIN_NEW_PASSWORD_LENGTH} caracteres para entrar pelo acesso da equipe.`}
                            </p>

                            <fieldset disabled={busy} className="space-y-3">
                                {needsCurrentPassword && capabilities.hasEmailIdentity && (
                                    <label htmlFor="inv-current-password">
                                        Senha atual
                                        <input
                                            id="inv-current-password"
                                            type="password"
                                            required
                                            autoComplete="current-password"
                                            value={currentPassword}
                                            onChange={(e) => setCurrentPassword(e.target.value)}
                                        />
                                    </label>
                                )}
                                <label htmlFor="inv-new-password">
                                    Nova senha
                                    <input
                                        id="inv-new-password"
                                        type="password"
                                        required
                                        minLength={MIN_NEW_PASSWORD_LENGTH}
                                        autoComplete="new-password"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                    />
                                </label>
                                <label htmlFor="inv-new-confirm-password">
                                    Confirmar nova senha
                                    <input
                                        id="inv-new-confirm-password"
                                        type="password"
                                        required
                                        minLength={MIN_NEW_PASSWORD_LENGTH}
                                        autoComplete="new-password"
                                        value={newConfirmPassword}
                                        onChange={(e) => setNewConfirmPassword(e.target.value)}
                                    />
                                </label>
                                <div className="flex gap-2">
                                    <button type="submit" className="admin-button primary" disabled={busy}>
                                        {busy ? 'Salvando…' : 'Salvar senha'}
                                    </button>
                                    <button
                                        type="button"
                                        className="admin-button"
                                        disabled={busy}
                                        onClick={closePasswordForm}
                                    >
                                        Fechar
                                    </button>
                                </div>
                            </fieldset>
                        </form>
                    )}
                </section>
            ) : (
                <section className="admin-card admin-form">
                    <div className="flex gap-3 mb-4">
                        <button
                            type="button"
                            className="admin-button"
                            disabled={busy}
                            aria-pressed={mode === 'login'}
                            onClick={() => { setMode('login'); setError(''); setNotice(''); clearSensitiveFields(); }}
                        >
                            Já tenho conta
                        </button>
                        <button
                            type="button"
                            className="admin-button"
                            disabled={busy}
                            aria-pressed={mode === 'signup'}
                            onClick={() => { setMode('signup'); setError(''); setNotice(''); clearSensitiveFields(); }}
                        >
                            Criar conta
                        </button>
                    </div>

                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                                if (mode === 'signup') {
                                    const check = validateNewPassword(password, confirmPassword);
                                    if (!check.valid) {
                                        throw new Error(check.error);
                                    }

                                    const redirect = new URL('/convite', window.location.origin);
                                    redirect.searchParams.set('token', token);
                                    const { data, error: signUpErr } = await supabase.auth.signUp({
                                        email: email.trim(),
                                        password,
                                        options: { emailRedirectTo: redirect.toString() },
                                    });

                                    if (signUpErr) throw signUpErr;

                                    if (data.session) {
                                        setNotice('Conta criada com sucesso! Clique em "Aceitar convite" abaixo para concluir seu vínculo.');
                                    } else {
                                        setNotice('Conta criada! Enviamos um link de confirmação para o seu e-mail. Após confirmar, retorne a esta mesma página de convite para aceitar seu acesso.');
                                    }
                                } else {
                                    const { error: signInErr } = await supabase.auth.signInWithPassword({
                                        email: email.trim(),
                                        password,
                                    });
                                    if (signInErr) throw signInErr;
                                }
                            });
                        }}
                    >
                        <fieldset disabled={busy} className="space-y-4">
                            <label htmlFor="inv-email">
                                E-mail
                                <input
                                    id="inv-email"
                                    type="email"
                                    autoComplete="email"
                                    required
                                    maxLength={254}
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                />
                            </label>
                            <label htmlFor="inv-password">
                                Senha
                                <input
                                    id="inv-password"
                                    type="password"
                                    required
                                    minLength={mode === 'signup' ? MIN_NEW_PASSWORD_LENGTH : 1}
                                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                            </label>
                            {mode === 'signup' && (
                                <>
                                    <label htmlFor="inv-confirm-password">
                                        Confirmar senha
                                        <input
                                            id="inv-confirm-password"
                                            type="password"
                                            required
                                            minLength={MIN_NEW_PASSWORD_LENGTH}
                                            autoComplete="new-password"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                        />
                                    </label>
                                    <p className="admin-help">
                                        Use pelo menos {MIN_NEW_PASSWORD_LENGTH} caracteres. Esta será sua senha de acesso pessoal. Não compartilhe com terceiros nem com o administrador.
                                    </p>
                                </>
                            )}
                            <button type="submit" className="admin-button primary" disabled={busy}>
                                {busy ? 'Aguarde…' : mode === 'signup' ? 'Criar minha conta' : 'Entrar'}
                            </button>
                        </fieldset>
                    </form>
                </section>
            )}
        </main>
    );
}
