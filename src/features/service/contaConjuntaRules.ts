export interface TabLike {
  id: string;
  label: string;
  status: 'open' | 'closed';
}

export function isSharedLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return l.includes('conjunta') || l.includes('compartilhada') || l.includes('mesa toda');
}

/**
 * Retorna apenas as comandas/pessoas individuais ativas (desconsiderando a conta conjunta).
 * Deduplica registros por ID para garantir a integridade dos dados reais do banco.
 */
export function getIndividualTabs<T extends TabLike>(tabs: T[]): T[] {
  const seen = new Set<string>();
  const individual: T[] = [];

  for (const tab of tabs) {
    if (tab.status === 'open' && !isSharedLabel(tab.label) && !seen.has(tab.id)) {
      seen.add(tab.id);
      individual.push(tab);
    }
  }

  return individual;
}

/**
 * A conta conjunta só deve ser exibida quando houver mais de uma pessoa real vinculada à mesa.
 * Com 0 ou 1 pessoa (apenas titular), retorna false.
 */
export function shouldShowContaConjunta<T extends TabLike>(tabs: T[]): boolean {
  const individuals = getIndividualTabs(tabs);
  return individuals.length > 1;
}

/**
 * Garante que se o usuário estiver selecionando uma conta conjunta, mas a mesa só tiver
 * uma pessoa ou nenhuma, a seleção seja redirecionada para a pessoa individual válida.
 */
export function resolveSafeSelectedTabId<T extends TabLike>(
  selectedTabId: string | null | undefined,
  tabs: T[],
): string | null {
  const individuals = getIndividualTabs(tabs);
  if (individuals.length === 0) return null;

  const currentTab = tabs.find((t) => t.id === selectedTabId);
  const isCurrentShared = currentTab ? isSharedLabel(currentTab.label) : false;

  // Se a conta conjunta não for permitida (<= 1 pessoa) e estava selecionada, redireciona
  if (individuals.length <= 1 && isCurrentShared) {
    return individuals[0].id;
  }

  // Se a comanda atual existir e estiver aberta, mantém
  if (currentTab && currentTab.status === 'open') {
    return currentTab.id;
  }

  return individuals[0].id;
}
