// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

/** Narrow, deterministic policy: no raw wg-quick text, DNS, IPv6 or broad routes. */
internal object VpnPolicy {
  const val MAX_CONFIG_BYTES = 8192
  const val MAX_PEERS = 64
  const val MAX_LIFETIME_MS = 7L * 24 * 60 * 60 * 1000

  fun identity(value: String) = value.matches(Regex("[a-f0-9]{64}"))
  fun address(value: String): Boolean {
    if (!value.endsWith("/32")) return false
    val parts = value.removeSuffix("/32").split('.')
    return parts.size == 4 && parts[0] == "10" && parts[1] == "203" &&
      parts.drop(2).all { it.matches(Regex("0|[1-9][0-9]{0,2}")) && it.toInt() <= 255 } &&
      parts[3].toInt() in 1..254
  }

  fun endpoint(value: String): Boolean {
    if (value.length !in 3..260 || value.count { it == ':' } != 1) return false
    val (host, port) = value.split(':')
    if (!port.matches(Regex("[1-9][0-9]{0,4}")) || port.toInt() !in 1..65535) return false
    if (host.matches(Regex("[0-9.]+"))) {
      val parts = host.split('.')
      if (parts.size != 4 || parts.any { !it.matches(Regex("0|[1-9][0-9]{0,2}")) || it.toInt() > 255 }) return false
      val octets = parts.map(String::toInt)
      return octets[0] in 1..223 && octets[0] != 127 && !(octets[0] == 169 && octets[1] == 254) &&
        !(octets[0] == 10 && octets[1] == 203) && host != "255.255.255.255"
    }
    // DNS names are resolved by WireGuard outside the tunnel. They cannot be
    // interface names, URLs, numeric aliases, single-label or local-only hosts.
    val labels = host.split('.')
    return host.length <= 253 && labels.size >= 2 && host == host.lowercase() &&
      labels.all { it.length in 1..63 && it.matches(Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")) } &&
      labels.last().matches(Regex("[a-z]{2,63}")) && labels.last() !in setOf("localhost", "local", "internal")
  }

  fun validate(address: String, peers: List<String>, endpoint: String, expiresAt: Long, now: Long) {
    require(address(address)) { "Use an assigned 10.203.x.x/32 private address." }
    require(peers.size in 1..MAX_PEERS && peers.toSet().size == peers.size && peers.all { address(it) && it != address }) {
      "Only unique, exact friend addresses in 10.203.0.0/16 are allowed."
    }
    require(endpoint(endpoint)) { "Use the hub's IPv4 address or DNS name and UDP port." }
    require(expiresAt > now && expiresAt - now <= MAX_LIFETIME_MS) { "Enrollment must expire within seven days." }
  }
}
