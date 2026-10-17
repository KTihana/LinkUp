// Use a unique basename: Metro may resolve index.js to the old index.ts.
// Register Android background tasks before Expo Router mounts any UI.
import './src/notifications/register';
import 'expo-router/entry';
