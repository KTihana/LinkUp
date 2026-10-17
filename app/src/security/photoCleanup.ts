import { File, Paths } from 'expo-file-system';
export function cleanupGeneratedPhoto(uri: string) {
  const cache = Paths.cache.uri.endsWith('/') ? Paths.cache.uri : Paths.cache.uri + '/';
  if (!uri.startsWith(cache)) throw new Error('Generated photo was not in the app cache.');
  const file = new File(uri);
  if (file.exists) file.delete();
}
export function cleanupPickerCopy(uri: string) {
  const cache = Paths.cache.uri.endsWith('/') ? Paths.cache.uri : Paths.cache.uri + '/';
  // Only remove the selected temporary copy created by the picker, never the gallery original.
  if (uri.startsWith(cache + 'ImagePicker/')) { const file = new File(uri); if (file.exists) file.delete(); }
}
