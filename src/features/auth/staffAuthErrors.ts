import { isQueryTimeoutError } from '../../lib/queryErrors';

/**
 * Utilitários puros para validação de senha e tradução de erros do Supabase Auth / RPCs de equipe,
 * sem expor senhas, sessões, tokens ou dados pessoais nos logs e mensagens.
 */

export const MIN_NEW_PASSWORD_LENGTH = 10;

export interface AuthErrorInfo {
    code?: string;
    message?: string;
    status?: number;
}

export function getAccessCheckFailureMessage(
    error: unknown,
    fallback: string,
): string {
    return isQueryTimeoutError(error)
        ? 'A verificação demorou além do limite. Seu acesso não foi negado; tente novamente.'
        : fallback;
}

export interface PasswordValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validação centralizada de nova senha (usada em cadastro, convite, perfil e recuperação).
 * Não deve ser aplicada ao login de contas existentes.
 */
export function validateNewPassword(
    password: string,
    confirmPassword?: string,
): PasswordValidationResult {
    if (!password || password.length < MIN_NEW_PASSWORD_LENGTH) {
        return {
            valid: false,
            error: `A senha deve ter pelo menos ${MIN_NEW_PASSWORD_LENGTH} caracteres.`,
        };
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
        return {
            valid: false,
            error: 'A confirmação de senha não coincide com a nova senha.',
        };
    }

    return { valid: true };
}

/**
 * Identifica se um erro do Supabase Auth é especificamente limite de envio de e-mail
 * (`over_email_send_rate_limit`), diferenciando-o de outros erros HTTP 429 (excesso de tentativas).
 */
export function isEmailSendRateLimitError(error: unknown): boolean {
    if (!error) return false;
    const err = error as AuthErrorInfo;
    const code = (err.code || '').toLowerCase();
    const rawMsg = (err.message || '').toLowerCase();

    return (
        code === 'over_email_send_rate_limit' ||
        rawMsg.includes('over_email_send_rate_limit') ||
        rawMsg.includes('email rate limit exceeded')
    );
}

/**
 * Identifica se um erro é HTTP 429 / excesso de requisições genérico (não específico de e-mail).
 */
export function isTooManyRequestsError(error: unknown): boolean {
    if (!error || isEmailSendRateLimitError(error)) return false;
    const err = error as AuthErrorInfo;
    const code = (err.code || '').toLowerCase();
    const rawMsg = (err.message || '').toLowerCase();

    return (
        err.status === 429 ||
        code === 'over_request_rate_limit' ||
        rawMsg.includes('too many requests') ||
        rawMsg.includes('rate limit')
    );
}

/**
 * Identifica se o servidor do Supabase exigiu reautenticação recente (`reauthentication_needed`)
 * para concluir a alteração de senha.
 */
export function isReauthenticationNeededError(error: unknown): boolean {
    if (!error) return false;
    const err = error as AuthErrorInfo;
    const code = (err.code || '').toLowerCase();
    const rawMsg = (err.message || '').toLowerCase();

    return (
        code === 'reauthentication_needed' ||
        rawMsg.includes('reauthentication') ||
        rawMsg.includes('reauthenticate')
    );
}

/**
 * Traduz erros retornados pelo Supabase Auth e RPCs durante cadastro, convite, redefinição e alteração de senha.
 */
export function getStaffInvitationErrorMessage(error: unknown): string {
    if (!error) return 'Ocorreu um erro desconhecido. Tente novamente.';

    const err = error as AuthErrorInfo;
    const rawMsg = (err.message || '').toLowerCase();
    const code = (err.code || '').toLowerCase();

    // 1a. Limite específico de envio de e-mails (over_email_send_rate_limit)
    if (isEmailSendRateLimitError(error)) {
        return 'O limite de envio de e-mails foi atingido no servidor. Nenhum e-mail foi enviado agora; tente novamente mais tarde.';
    }

    // 1b. Outros erros HTTP 429 (excesso de tentativas / requisições)
    if (isTooManyRequestsError(error)) {
        return 'Excesso de tentativas em curto período. Aguarde antes de tentar novamente.';
    }

    // 2. Reautenticação exigida pelo Supabase ao alterar senha
    if (isReauthenticationNeededError(error)) {
        return 'Por segurança, confirme sua senha atual ou faça login novamente para alterar a senha.';
    }

    // 3. Nova senha igual à anterior (same_password)
    if (
        code === 'same_password' ||
        rawMsg.includes('different from the old password') ||
        rawMsg.includes('same_password')
    ) {
        return 'A nova senha deve ser diferente da senha atual.';
    }

    // 4. Senha fraca / fora dos requisitos do servidor ou local
    if (
        code === 'weak_password' ||
        (rawMsg.includes('password') &&
            (rawMsg.includes('least') ||
                rawMsg.includes('short') ||
                rawMsg.includes('weak') ||
                rawMsg.includes('character') ||
                rawMsg.includes('caracteres')))
    ) {
        return `A senha informada não atende aos requisitos de segurança. Use pelo menos ${MIN_NEW_PASSWORD_LENGTH} caracteres e siga as exigências do servidor.`;
    }

    // 5. Sessão ausente ou expirada
    if (
        code === 'session_not_found' ||
        code === 'no_authorization' ||
        rawMsg.includes('auth session missing') ||
        rawMsg.includes('session_not_found') ||
        rawMsg.includes('jwt expired')
    ) {
        return 'Sua sessão expirou ou não está ativa. Entre novamente na sua conta para continuar.';
    }

    // 6. Usuário já cadastrado
    if (
        code === 'user_already_exists' ||
        rawMsg.includes('already registered') ||
        rawMsg.includes('already exists')
    ) {
        return 'Este e-mail já possui uma conta criada. Alterne para a opção "Já tenho conta" para entrar e aceitar o convite.';
    }

    // 7. E-mail não confirmado
    if (
        code === 'email_not_confirmed' ||
        rawMsg.includes('email not confirmed') ||
        rawMsg.includes('confirme seu e-mail')
    ) {
        return 'Seu e-mail ainda não foi confirmado. Verifique sua caixa de entrada e a pasta de spam para confirmar seu e-mail antes de aceitar o convite.';
    }

    // 8. Credenciais inválidas no login
    if (
        code === 'invalid_credentials' ||
        rawMsg.includes('invalid login credentials') ||
        rawMsg.includes('invalid credentials')
    ) {
        return 'E-mail ou senha incorretos. Confira os dados informados. Se ainda não criou sua conta, selecione "Criar conta".';
    }

    // 9. Falha de rede ou conexão
    if (
        rawMsg.includes('failed to fetch') ||
        rawMsg.includes('networkerror') ||
        rawMsg.includes('network request failed')
    ) {
        return 'Não foi possível conectar ao servidor. Verifique sua conexão com a internet e tente novamente.';
    }

    // 10. Erros específicos da RPC accept_staff_invitation
    if (rawMsg.includes('convite inválido ou restaurante indisponível')) {
        return 'Este convite não é válido ou o restaurante não está ativo. Peça um novo link ao administrador.';
    }
    if (rawMsg.includes('convite vencido ou revogado')) {
        return 'Este convite expirou ou foi cancelado pelo administrador. Solicite um novo link.';
    }
    if (rawMsg.includes('entre com o e-mail ao qual o administrador enviou este convite')) {
        return 'A conta conectada possui um e-mail diferente do e-mail deste convite. Saia e conecte-se com o e-mail correto.';
    }
    if (rawMsg.includes('responsável pelo convite não possui mais acesso')) {
        return 'O administrador que gerou este convite não tem mais permissão. Peça a outro administrador da equipe para gerar um novo convite.';
    }
    if (rawMsg.includes('vínculo foi desativado')) {
        return 'O seu acesso neste restaurante está desativado. Peça ao administrador para reativar seu cadastro na equipe.';
    }

    return err.message || 'Não foi possível concluir a operação. Verifique os dados e tente novamente.';
}

/**
 * Traduz erros do login operacional do restaurante (AccessPage), preservando segurança contra enumeração
 * e diferenciando limite de envio de e-mail de excesso de tentativas (HTTP 429).
 */
export function getStaffLoginErrorMessage(error: unknown): string {
    if (!error) return 'Não foi possível entrar. Tente novamente.';

    const err = error as AuthErrorInfo;
    const rawMsg = (err.message || '').toLowerCase();
    const code = (err.code || '').toLowerCase();

    if (isEmailSendRateLimitError(error)) {
        return 'O limite de envio de e-mails foi atingido no servidor. Nenhum e-mail foi enviado agora; tente novamente mais tarde.';
    }

    if (isTooManyRequestsError(error)) {
        return 'Excesso de tentativas em curto período. Tente novamente mais tarde.';
    }

    if (
        code === 'invalid_credentials' ||
        rawMsg.includes('invalid login credentials') ||
        rawMsg.includes('invalid credentials')
    ) {
        return 'E-mail ou senha incorretos. Confira os dados e tente novamente.';
    }

    if (
        code === 'email_not_confirmed' ||
        rawMsg.includes('email not confirmed')
    ) {
        return 'Seu e-mail ainda não foi confirmado. Verifique sua caixa de entrada antes de entrar.';
    }

    if (
        rawMsg.includes('failed to fetch') ||
        rawMsg.includes('networkerror') ||
        rawMsg.includes('network request failed')
    ) {
        return 'Falha de conexão com a rede. Verifique sua internet e tente novamente.';
    }

    return err.message || 'Não foi possível entrar. Confira e-mail e senha e tente novamente.';
}

/**
 * Mensagem neutra para recuperação de senha que não expõe se a conta existe ou não.
 */
export function getStaffRecoverySuccessMessage(email: string): string {
    return `Se houver uma conta associada a ${email.trim()}, as instruções de recuperação de senha foram enviadas. Verifique a caixa de entrada e a pasta de spam.`;
}

export interface AuthPasswordCapabilities {
    hasEmailIdentity: boolean;
    hasGoogleIdentity: boolean;
}

/**
 * Inspeciona os provedores de autenticação da conta sem presumir que uma conta Google
 * possua senha anterior configurada.
 */
export function inspectUserPasswordCapabilities(
    user:
        | {
              app_metadata?: { provider?: string; providers?: string[] };
              identities?: Array<{ provider?: string }>;
          }
        | null
        | undefined,
): AuthPasswordCapabilities {
    if (!user) {
        return { hasEmailIdentity: false, hasGoogleIdentity: false };
    }

    const providers = new Set<string>();
    if (typeof user.app_metadata?.provider === 'string') {
        providers.add(user.app_metadata.provider.toLowerCase());
    }
    if (Array.isArray(user.app_metadata?.providers)) {
        for (const p of user.app_metadata.providers) {
            if (typeof p === 'string') providers.add(p.toLowerCase());
        }
    }
    if (Array.isArray(user.identities)) {
        for (const id of user.identities) {
            if (typeof id?.provider === 'string') providers.add(id.provider.toLowerCase());
        }
    }

    return {
        hasEmailIdentity: providers.has('email'),
        hasGoogleIdentity: providers.has('google'),
    };
}

export interface UpdatePasswordOptions {
    newPassword: string;
    confirmPassword: string;
    currentPassword?: string;
}

export interface UpdatePasswordResult {
    updated: boolean;
    requiresCurrentPassword?: boolean;
}

export interface PasswordAuthClient {
    getSession: () => Promise<{
        data: {
            session: {
                user?: {
                    id?: string;
                    email?: string | null;
                    is_anonymous?: boolean;
                } | null;
            } | null;
        } | null;
        error: unknown;
    }>;
    signInWithPassword: (credentials: {
        email: string;
        password: string;
    }) => Promise<{ data?: unknown; error: unknown }>;
    updateUser: (attributes: { password: string }) => Promise<{
        data: { user?: { id?: string } | null } | null;
        error: unknown;
    }>;
}

/**
 * Executa a definição ou alteração de senha na conta autenticada usando os métodos oficiais
 * do Supabase Auth (`getSession`, `signInWithPassword` quando reautenticação for necessária, e `updateUser`).
 * Só confirma `updated: true` quando o servidor retorna o usuário atualizado.
 */
export async function executePasswordUpdateWithClient(
    options: UpdatePasswordOptions,
    authClient: PasswordAuthClient,
): Promise<UpdatePasswordResult> {
    const check = validateNewPassword(options.newPassword, options.confirmPassword);
    if (!check.valid) {
        throw new Error(check.error);
    }

    const { data: sessionData, error: sessionError } = await authClient.getSession();
    if (sessionError) {
        throw sessionError;
    }

    const user = sessionData?.session?.user;
    if (!user || user.is_anonymous) {
        const err = new Error(
            'Sua sessão expirou ou não está ativa. Entre novamente na sua conta para continuar.',
        );
        (err as { code?: string }).code = 'session_not_found';
        throw err;
    }

    if (options.currentPassword && options.currentPassword.length > 0 && user.email) {
        const { error: signInErr } = await authClient.signInWithPassword({
            email: user.email,
            password: options.currentPassword,
        });
        if (signInErr) {
            throw signInErr;
        }
    }

    const { data: updateData, error: updateErr } = await authClient.updateUser({
        password: options.newPassword,
    });

    if (updateErr) {
        if (isReauthenticationNeededError(updateErr)) {
            return { updated: false, requiresCurrentPassword: true };
        }
        throw updateErr;
    }

    if (!updateData?.user?.id) {
        throw new Error('O servidor não confirmou a atualização da senha. Tente novamente.');
    }

    return { updated: true };
}

