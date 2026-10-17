// SPDX-License-Identifier: GPL-3.0-only
const { withAndroidManifest } = require('expo/config-plugins');

// Permissions are declared during CNG. Dangerous permissions are requested by
// CommonNearby only when the user starts the corresponding nearby action.
module.exports = function withNearby(config) {
  return withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];
    const declarations = [
      { 'android:name': 'android.permission.INTERNET' },
      { 'android:name': 'android.permission.ACCESS_NETWORK_STATE' },
      { 'android:name': 'android.permission.ACCESS_WIFI_STATE' },
      { 'android:name': 'android.permission.CHANGE_WIFI_STATE' },
      {
        'android:name': 'android.permission.NEARBY_WIFI_DEVICES',
        'android:usesPermissionFlags': 'neverForLocation',
      },
      {
        'android:name': 'android.permission.ACCESS_FINE_LOCATION',
        'android:maxSdkVersion': '32',
      },
      { 'android:name': 'android.permission.BLUETOOTH', 'android:maxSdkVersion': '30' },
      { 'android:name': 'android.permission.BLUETOOTH_ADMIN', 'android:maxSdkVersion': '30' },
      {
        'android:name': 'android.permission.BLUETOOTH_SCAN',
        'android:usesPermissionFlags': 'neverForLocation',
      },
      { 'android:name': 'android.permission.BLUETOOTH_CONNECT' },
      { 'android:name': 'android.permission.BLUETOOTH_ADVERTISE' },
    ];
    for (const declaration of declarations) {
      const existing = permissions.find((item) => item.$?.['android:name'] === declaration['android:name']);
      if (existing) existing.$ = { ...existing.$, ...declaration };
      else permissions.push({ $: declaration });
    }
    manifest['uses-permission'] = permissions;
    return result;
  });
};
