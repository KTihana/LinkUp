// SPDX-License-Identifier: GPL-3.0-only
import type { VaultSnapshot } from '../security/vaultCore';

/** Route state survives account setup, which remounts the account UI. */
export function invitationSetupRoute(input: string) {
  return { pathname: '/invite' as const, params: { token: input, page: 'Local vault', returnTo: 'Add friend' } };
}

export function shouldResumeInvitation(input: string | undefined, returnTo: string | undefined, status: VaultSnapshot['status']): boolean {
  return input !== undefined && returnTo === 'Add friend' && status === 'unlocked';
}
