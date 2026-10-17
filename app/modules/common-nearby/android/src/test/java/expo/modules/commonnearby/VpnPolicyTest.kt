// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertSame
import org.junit.Assert.assertNotSame
import org.junit.Assert.fail
import org.junit.Test

class VpnPolicyTest {
  @Test fun statusReloadDoesNotInvalidateUnchangedSocketEnrollment() {
    val current = VpnEnrollment("a".repeat(64), "public-device", "Friends", "10.203.1.1/32", "public-hub", "vpn.example.org:51820", listOf("10.203.1.2/32"), 1800000000000)
    assertSame(current, stableEnrollment(current, current.copy(peers = current.peers.toList())))
    assertNotSame(current, stableEnrollment(current, current.copy(peers = listOf("10.203.1.3/32"))))
    assertTrue(stableEnrollment(current, null) == null)
  }
  @Test fun onlyExactPrivateFriendRoutesAreAccepted() {
    for (address in listOf("10.203.0.1/32", "10.203.16.2/32", "10.203.255.254/32")) assertTrue(address, VpnPolicy.address(address))
    for (address in listOf("0.0.0.0/0", "10.203.0.0/16", "10.203.0.1/24", "::/0", "fd00::1/128", "192.168.0.1/32", "10.204.1.2/32", "10.203.00.1/32", "10.203.0.0/32", "10.203.1.255/32", "10.203.256.1/32", "10.203.1.1", "10.203.1.1/032")) assertFalse(address, VpnPolicy.address(address))
  }
  @Test fun endpointCannotInjectConfigurationOrRedirectToAnInterface() {
    for (endpoint in listOf("203.0.113.4:51820", "192.168.1.2:51820", "vpn.example.org:443")) assertTrue(endpoint, VpnPolicy.endpoint(endpoint))
    for (endpoint in listOf("127.0.0.1:51820", "0.0.0.0:51820", "10.203.1.1:51820", "169.254.1.1:51820", "224.0.0.1:51820", "vpn.example.org:0", "vpn.example.org:65536", "vpn.example.org:080", "https://vpn.example.org:443", "localhost:51820", "test.local:51820", "127.1:51820", "2130706433:51820", "01.2.3.4:51820", "vpn.example.org:51820\nDNS=8.8.8.8", "host:51820", "foo..com:51820", "foo.123:51820", "[::1]:51820")) assertFalse(endpoint, VpnPolicy.endpoint(endpoint))
  }
  @Test fun selfRoutesDuplicatesExpiredAndExcessiveEnrollmentsFailClosed() {
    val now = 1_800_000_000_000L
    VpnPolicy.validate("10.203.1.1/32", listOf("10.203.1.2/32"), "vpn.example.org:51820", now + 1, now)
    fun rejected(peers: List<String>, expiry: Long = now + 60_000) {
      try { VpnPolicy.validate("10.203.1.1/32", peers, "vpn.example.org:51820", expiry, now); fail("Unsafe enrollment accepted") }
      catch (_: IllegalArgumentException) { }
    }
    rejected(emptyList()); rejected(listOf("10.203.1.1/32")); rejected(listOf("10.203.1.2/32", "10.203.1.2/32"))
    rejected(listOf("0.0.0.0/0")); rejected((2..66).map { "10.203.1.$it/32" })
    rejected(listOf("10.203.1.2/32"), now); rejected(listOf("10.203.1.2/32"), now - 1)
    rejected(listOf("10.203.1.2/32"), now + VpnPolicy.MAX_LIFETIME_MS + 1)
  }
}
