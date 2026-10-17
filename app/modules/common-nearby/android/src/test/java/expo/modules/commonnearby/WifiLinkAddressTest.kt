// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class WifiLinkAddressTest {
  @Test fun privateAndLoopbackAddressesUseExactNumericBytes() {
    for (host in listOf("10.23.7.1", "172.16.0.1", "172.31.8.2", "192.168.43.1", "169.254.7.2", "127.0.0.1")) {
      assertEquals(host, WifiLink.localAddress(host).hostAddress)
    }
  }

  @Test fun publicNamesAlternateNotationAndBroadcastAreRejectedBeforeResolution() {
    for (host in listOf("8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "example.com", "localhost",
      "::1", "10.1.1", "10.01.1.1", "0xa.0.0.1", "10.0.0.256", "10.0.0.-1", "10.0.0.255", "127.0.0.0")) {
      try { WifiLink.localAddress(host); fail("Accepted $host") }
      catch (_: IllegalArgumentException) { /* Expected: no DNS or Internet socket. */ }
    }
  }
}
