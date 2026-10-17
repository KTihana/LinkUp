// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyStore
class NativeCompletionTest {
  @Test fun cleanupDoesNotReturnAnUnsupportedKeyStoreToExpo() {
    var calls = 0
    val result = nativeCompletion { calls++; KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null) } }
    assertSame(Unit, result); assertEquals(1, calls)
  }
  @Test fun storageFailuresStillRejectInsteadOfReportingSuccess() {
    try { nativeCompletion { error("Storage failed") }; fail("Failure swallowed") }
    catch (e: IllegalStateException) { assertEquals("Storage failed", e.message) }
  }
}
