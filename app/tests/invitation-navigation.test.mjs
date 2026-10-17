// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationSetupRoute, shouldResumeInvitation } from '../src/friends/invitationNavigation.ts';

test('account setup retains an invitation in route state across account UI remounts', () => {
  const input = 'https://ktihana.github.io/LinkUp/#pending-invitation';
  const route = invitationSetupRoute(input);
  const reopened = new URL(`https://app.example${route.pathname}?${new URLSearchParams(route.params)}`);
  assert.equal(reopened.pathname, '/invite');
  assert.equal(reopened.searchParams.get('token'), input);
  assert.equal(reopened.searchParams.get('page'), 'Local vault');
  for (const status of ['loading', 'preview', 'locked', 'error', 'resetting']) assert.equal(shouldResumeInvitation(input, reopened.searchParams.get('returnTo'), status), false);
  assert.equal(shouldResumeInvitation(reopened.searchParams.get('token'), reopened.searchParams.get('returnTo'), 'unlocked'), true);
  assert.equal(shouldResumeInvitation(undefined, 'Add friend', 'unlocked'), false);
  assert.equal(shouldResumeInvitation(input, undefined, 'unlocked'), false);
});
