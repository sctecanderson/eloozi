export interface StaffExtendedProfile {
    id: string;
    name: string;
    email: string;
    phone: string;
    cpf: string;
    birthDate: string;
    avatarUrl?: string;
    cargo: string;
    active: boolean;
    permissions: string[];
    createdAt: string;
}

export type StaffProfileMap = Record<string, StaffExtendedProfile>;
export type RpcFn = <T>(name: string, values: Record<string, unknown>) => Promise<T>;

export const LEGACY_PROFILES_STORAGE_KEY = 'elozi_staff_profiles_';

export const normalizeEmail = (email: string | null | undefined) => (email ?? '').trim().toLowerCase();

/** Indexa perfis pelo e-mail normalizado (chave de associação convite → membro). */
export function indexProfilesByEmail(list: StaffExtendedProfile[]): StaffProfileMap {
    const map: StaffProfileMap = {};
    for (const p of list) {
        const key = normalizeEmail(p.email);
        if (key) map[key] = p;
    }
    return map;
}

/** Perfil de um membro/convite: pelo e-mail; id apenas como complemento. */
export function resolveProfile(
    profiles: StaffProfileMap,
    ref: { id?: string; email?: string | null },
): StaffExtendedProfile | undefined {
    const byEmail = profiles[normalizeEmail(ref.email)];
    if (byEmail) return byEmail;
    return ref.id ? profiles[ref.id] : undefined;
}

/**
 * Nome exibido: o nome informado nunca é substituído pelo derivado do e-mail.
 * O trecho do e-mail só é usado quando não existe nenhum perfil salvo.
 */
export function displayName(profile: StaffExtendedProfile | undefined, email: string | null | undefined): string {
    const typed = profile?.name?.trim();
    if (typed) return typed;
    const local = (email ?? '').split('@')[0];
    return local || 'Funcionário';
}

/** Lê perfis do armazenamento local antigo (somente para migração; nunca grava). */
export function readLegacyProfiles(storage: Pick<Storage, 'getItem'>, slug: string): StaffExtendedProfile[] {
    try {
        const raw = storage.getItem(`${LEGACY_PROFILES_STORAGE_KEY}${slug}`);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as Record<string, StaffExtendedProfile>;
        const seen = new Map<string, StaffExtendedProfile>();
        for (const p of Object.values(parsed)) {
            const key = normalizeEmail(p?.email);
            if (key && p.name && !seen.has(key)) seen.set(key, { ...p, email: key });
        }
        return [...seen.values()];
    } catch {
        return [];
    }
}

export function createStaffProfileApi(rpc: RpcFn) {
    return {
        async list(slug: string): Promise<StaffExtendedProfile[]> {
            return (await rpc<StaffExtendedProfile[]>('get_staff_profiles', { p_slug: slug })) ?? [];
        },
        async save(slug: string, profile: StaffExtendedProfile): Promise<StaffExtendedProfile> {
            const saved = await rpc<StaffExtendedProfile>('upsert_staff_profile', {
                p_slug: slug,
                p_profile: { ...profile, email: normalizeEmail(profile.email) },
            });
            if (!saved || !saved.name) throw new Error('Os dados do funcionário não foram confirmados pelo servidor.');
            return saved;
        },
        async remove(slug: string, email: string): Promise<void> {
            await rpc('delete_staff_profile', { p_slug: slug, p_email: normalizeEmail(email) });
        },
        /**
         * Envia ao servidor perfis do localStorage antigo que ainda não existem lá.
         * Nada é apagado aqui: `migrated` lista só o que o servidor confirmou e `failed`
         * lista o que NÃO foi migrado (o registro local original deve ser mantido).
         * Fotos acima do limite são reduzidas por `shrinkAvatar`; se ainda assim não
         * couberem, o perfil não é gravado (evita perder a foto em silêncio).
         */
        async migrateLegacy(
            slug: string,
            legacy: StaffExtendedProfile[],
            existing: StaffExtendedProfile[],
            shrinkAvatar?: (dataUrl: string) => Promise<string>,
        ): Promise<LegacyMigrationResult> {
            const have = new Set(existing.map((p) => normalizeEmail(p.email)));
            const result: LegacyMigrationResult = { migrated: [], failed: [] };
            for (const p of legacy) {
                const key = normalizeEmail(p.email);
                if (have.has(key)) {
                    result.migrated.push(key);
                    continue;
                }
                let candidate = p;
                if (p.avatarUrl && !isStorableAvatar(p.avatarUrl)) {
                    let smaller = '';
                    try {
                        smaller = shrinkAvatar ? await shrinkAvatar(p.avatarUrl) : '';
                    } catch {
                        smaller = '';
                    }
                    if (!smaller || !isStorableAvatar(smaller)) {
                        result.failed.push({ email: key, name: p.name, reason: 'avatar_too_large' });
                        continue;
                    }
                    candidate = { ...p, avatarUrl: smaller };
                }
                try {
                    await this.save(slug, candidate);
                    result.migrated.push(key);
                } catch {
                    result.failed.push({ email: key, name: p.name, reason: 'save_error' });
                }
            }
            return result;
        },
    };
}

export const AVATAR_MAX_CHARS = 300000;

/** Mesma regra da migration: data URL jpeg/png/webp com até 300 mil caracteres. */
export function isStorableAvatar(url: string | undefined): boolean {
    return !url || (url.length <= AVATAR_MAX_CHARS && /^data:image\/(jpeg|png|webp);base64,/.test(url));
}

export interface LegacyFailure {
    email: string;
    name: string;
    reason: 'avatar_too_large' | 'save_error';
}
export interface LegacyMigrationResult {
    migrated: string[];
    failed: LegacyFailure[];
}

export function describeLegacyFailures(failed: LegacyFailure[]): string {
    if (failed.length === 0) return '';
    const items = failed
        .map((f) => `${f.name} (${f.reason === 'avatar_too_large' ? 'foto acima do limite' : 'erro ao salvar'})`)
        .join(', ');
    return `${failed.length} perfil(is) antigo(s) NÃO foram migrados para o servidor: ${items}. Os dados originais continuam neste navegador; reduza a foto ou tente novamente ao reabrir a tela.`;
}

export interface OutcomeStep {
    label: string;
    status: 'ok' | 'failed' | 'skipped';
    detail?: string;
}
export interface Outcome {
    kind: 'success' | 'partial' | 'failure';
    message: string;
}

/**
 * Resume etapas executadas em chamadas separadas (NÃO atômicas). Só é "success"
 * quando todas deram certo; caso contrário diz o que funcionou e o que falhou.
 */
export function summarizeOutcome(steps: OutcomeStep[], reloaded: boolean): Outcome {
    const ok = steps.filter((s) => s.status === 'ok');
    const failed = steps.filter((s) => s.status === 'failed');
    const skipped = steps.filter((s) => s.status === 'skipped');
    const tail = reloaded
        ? 'A lista foi recarregada do servidor.'
        : 'Não foi possível recarregar o estado do servidor; a lista pode estar desatualizada.';
    if (failed.length === 0 && skipped.length === 0) {
        return { kind: 'success', message: '' };
    }
    const parts = [
        `Funcionou: ${ok.length ? ok.map((s) => s.label).join('; ') : 'nada'}.`,
        `Falhou: ${failed.length ? failed.map((s) => (s.detail ? `${s.label} (${s.detail})` : s.label)).join('; ') : 'nada'}.`,
    ];
    if (skipped.length) parts.push(`Não executado: ${skipped.map((s) => s.label).join('; ')}.`);
    parts.push(`Estas etapas são chamadas separadas e não atômicas, por isso o resultado pode ser parcial. ${tail}`);
    return { kind: ok.length > 0 ? 'partial' : 'failure', message: parts.join(' ') };
}
export type StaffAccessState = 'access_active' | 'access_inactive' | 'invite_pending' | 'profile_saved' | 'removed';

/**
 * Determina se um registro de membro representa um vínculo removido da equipe.
 * Quando o vínculo em restaurant_members está desativado (active = false) e não há
 * mais perfil cadastrado em staff_profiles para este restaurante, o colaborador
 * foi removido da equipe. O registro de vínculo é mantido exclusivamente para
 * garantir a integridade referencial do histórico de comandas e atendimentos.
 */
export function isStaffMemberRemoved(m: { active: boolean; hasProfile?: boolean; isInvitePending?: boolean }): boolean {
    if (m.isInvitePending) return false;
    return !m.active && !m.hasProfile;
}

/**
 * Estado real exibido ao administrador. "Acesso" só existe com vínculo em
 * restaurant_members (convite aceito); o perfil complementar sozinho não dá acesso.
 */
export function staffAccessState(m: {
    memberId?: string;
    inviteId?: string;
    active: boolean;
    hasProfile?: boolean;
}): StaffAccessState {
    if (m.memberId) {
        if (!m.active && m.hasProfile === false) return 'removed';
        return m.active ? 'access_active' : 'access_inactive';
    }
    if (m.inviteId) return 'invite_pending';
    return 'profile_saved';
}

export const STAFF_ACCESS_LABEL: Record<StaffAccessState, string> = {
    access_active: 'Acesso ativo',
    access_inactive: 'Acesso inativo',
    invite_pending: 'Convite pendente',
    profile_saved: 'Perfil salvo (sem convite nem acesso)',
    removed: 'Vínculo removido (histórico preservado)',
};
