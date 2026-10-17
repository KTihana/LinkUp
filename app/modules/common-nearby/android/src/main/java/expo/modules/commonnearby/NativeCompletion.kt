// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

// Expo serializes the inferred lambda result. Side effects must never leak a
// KeyStore, editor, WorkManager Operation, or another Android object to JS.
internal inline fun nativeCompletion(action: () -> Any?): Unit { action() }
