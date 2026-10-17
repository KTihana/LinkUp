// SPDX-License-Identifier: GPL-3.0-only
const { withMainActivity } = require('expo/config-plugins');
const marker = '// LinkUp private screen';
function protectActivity(source) {
  if (source.includes(marker)) return source;
  const entry = /override fun onCreate\(savedInstanceState: Bundle\?\) \{/g;
  if ([...source.matchAll(entry)].length !== 1) throw new Error('LinkUp screen protection requires the expected Kotlin activity template.');
  return source.replace(entry, match => `${match}\n    ${marker}\n    window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)`);
}
module.exports = config => withMainActivity(config, result => {
  if (result.modResults.language !== 'kt') throw new Error('LinkUp requires a Kotlin activity for screen protection.');
  result.modResults.contents = protectActivity(result.modResults.contents);
  return result;
});
module.exports.protectActivity = protectActivity;
