// SPDX-License-Identifier: GPL-3.0-only
import { Directory, Paths } from 'expo-file-system';
export async function eraseAccountCaches() {
  // App-private cache only. Never delete originals from the user's gallery.
  for (const entry of new Directory(Paths.cache).list()) entry.delete();
}
