// SPDX-License-Identifier: GPL-3.0-only
package expo.modules.commonnearby
import org.junit.Assert.*
import org.junit.Test
class UpdatePolicyTest {
  private val url = "https://github.com/KTihana/Tiho/releases/download/v0.1.1/tiho-0.1.1-arm64.apk"
  @Test fun sourceIsAnExactGithubHttpsReleasePath() {
    assertTrue(UpdatePolicy.source(url))
    for (bad in listOf(url.replace("https:", "http:"), url.replace("github.com", "github.com.evil.test"), url.replace("github.com", "user@github.com"), url + "?next=evil", url + "#x", url.replace("github.com", "github.com:443"), url.replace("tiho-", "../tiho-"))) assertFalse(bad, UpdatePolicy.source(bad))
  }
  @Test fun redirectsNeverLeaveGithubHttpsHosts() {
    assertTrue(UpdatePolicy.redirect("https://release-assets.githubusercontent.com/path?token=public"))
    assertTrue(UpdatePolicy.redirect("https://objects.githubusercontent.com/path"))
    for (bad in listOf("http://github.com/path", "https://evil.test/path", "https://github.com.evil.test/path", "https://user@github.com/path", "https://github.com:444/path")) assertFalse(UpdatePolicy.redirect(bad))
  }
  @Test fun onlyExactSingleSignerPackageAndNewVersionCanUpgrade() {
    val signer = listOf(byteArrayOf(1,2,3))
    assertTrue(UpdatePolicy.candidate("tiho", "tiho", 1, 2, 2, signer, signer))
    assertFalse(UpdatePolicy.candidate("tiho", "other", 1, 2, 2, signer, signer))
    assertFalse(UpdatePolicy.candidate("tiho", "tiho", 2, 2, 2, signer, signer))
    assertFalse(UpdatePolicy.candidate("tiho", "tiho", 3, 2, 2, signer, signer))
    assertFalse(UpdatePolicy.candidate("tiho", "tiho", 1, 2, 3, signer, signer))
    assertFalse(UpdatePolicy.candidate("tiho", "tiho", 1, 2, 2, signer, listOf(byteArrayOf(9))))
    assertFalse(UpdatePolicy.candidate("tiho", "tiho", 1, 2, 2, signer, emptyList()))
    assertFalse(UpdatePolicy.candidate("tiho", "tiho", 1, 2, 2, signer, signer + signer))
  }
}
