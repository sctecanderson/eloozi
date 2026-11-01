import { supabase } from '../../lib/supabase';

export type StaffRole = 'admin' | 'waiter';

export interface TeamMember {
  id: string;
  userId: string;
  email: string | null;
  role: StaffRole;
  active: boolean;
  openVisits: number;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: StaffRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
}

export interface TeamState {
  members: TeamMember[];
  invitations: TeamInvite[];
}

import {
  createStaffProfileApi,
  LEGACY_PROFILES_STORAGE_KEY,
  normalizeEmail,
  type StaffExtendedProfile,
} from './staffProfiles';

export type { StaffExtendedProfile };

/**
 * Remove do localStorage antigo apenas os perfis já confirmados no servidor.
 * Nunca registra dados pessoais em log.
 */
export function clearMigratedLegacyProfiles(slug: string, migratedEmails: string[]): void {
  try {
    const key = `${LEGACY_PROFILES_STORAGE_KEY}${slug}`;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const done = new Set(migratedEmails.map(normalizeEmail));
    const map = JSON.parse(raw) as Record<string, StaffExtendedProfile>;
    const kept: Record<string, StaffExtendedProfile> = {};
    for (const [k, p] of Object.entries(map)) {
      if (!done.has(normalizeEmail(p?.email))) kept[k] = p;
    }
    if (Object.keys(kept).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(kept));
  } catch {
    // falha ao limpar o cache antigo não afeta os dados do servidor
  }
}

export async function teamRpc<T>(name: string, values: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, values);
  if (error) {
    throw new Error(error.message || 'Não foi possível atualizar a equipe.');
  }
  return data as T;
}

export const staffProfileApi = createStaffProfileApi(teamRpc);

export const getTeam = (slug: string) => teamRpc<TeamState>('get_staff_management', { p_slug: slug });

export async function createInvite(slug: string, email: string, role: StaffRole) {
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  await teamRpc('create_staff_invitation', { p_slug: slug, p_email: email, p_role: role, p_token: token });
  const trimmedEmail = email.trim().toLowerCase();
  return `${window.location.origin}/convite?token=${token}&email=${encodeURIComponent(trimmedEmail)}`;
}

export const revokeInvite = (slug: string, id: string) =>
  teamRpc('revoke_staff_invitation', { p_slug: slug, p_id: id });

export const updateMember = (slug: string, member: TeamMember, role: StaffRole, active: boolean) =>
  teamRpc('update_staff_member', {
    p_slug: slug,
    p_id: member.id,
    p_role: role,
    p_active: active,
    p_expected_role: member.role,
    p_expected_active: member.active,
  });

export const transferVisits = (slug: string, from: string, to: string) =>
  teamRpc<number>('transfer_staff_visits', { p_slug: slug, p_from: from, p_to: to });

export const acceptInvite = (token: string) =>
  teamRpc<{
    slug: string;
    role: StaffRole;
  }>('accept_staff_invitation', { p_token: token });
