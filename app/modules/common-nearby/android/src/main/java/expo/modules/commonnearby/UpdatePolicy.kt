// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby

import java.net.URI

internal object UpdatePolicy {
  const val MAX_BYTES = 200L * 1024 * 1024
  fun source(url: String): Boolean = try {
    val u = URI(url)
    u.scheme == "https" && u.host == "github.com" && u.port == -1 && u.rawUserInfo == null &&
      u.rawQuery == null && u.rawFragment == null && Regex("/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/v[0-9]+\\.[0-9]+\\.[0-9]+/tiho-[0-9]+\\.[0-9]+\\.[0-9]+-arm64\\.apk").matches(u.rawPath)
  } catch (_: Exception) { false }
  fun redirect(url: String): Boolean = try {
    val u = URI(url)
    u.scheme == "https" && u.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com") &&
      u.port == -1 && u.rawUserInfo == null && u.rawFragment == null
  } catch (_: Exception) { false }
  fun candidate(installedPackage: String, candidatePackage: String, installedCode: Long, candidateCode: Long, expectedCode: Long, installedSigners: List<ByteArray>, candidateSigners: List<ByteArray>): Boolean =
    installedPackage == candidatePackage && candidateCode == expectedCode && candidateCode > installedCode &&
      installedSigners.size == 1 && candidateSigners.size == 1 && installedSigners[0].contentEquals(candidateSigners[0])
}
