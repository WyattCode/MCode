package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 「创建 PR」 has no call behind it - the gateway reads pull requests and cannot
 * file one - so the button opens the forge's compare page instead. That makes
 * this one string the whole of the feature, and a wrong URL is a button that
 * lands on a 404 with no way for the reader to tell what went wrong.
 */
class PullRequestUrlTest {

    @Test
    fun httpsRemoteGetsTheCompareRoute() {
        assertEquals(
            "https://github.com/WyattCode/MCode/compare/main...fix%2Fselection-one-to-one?expand=1",
            pullRequestUrl("https://github.com/WyattCode/MCode.git", "fix/selection-one-to-one"),
        )
    }

    @Test
    fun theGitSuffixIsDropped() {
        // GitHub would 404 on /compare with ".git" still on the repository name.
        val url = pullRequestUrl("https://github.com/owner/repo.git", "feat/x")
        assertEquals("https://github.com/owner/repo/compare/main...feat%2Fx?expand=1", url)
    }

    @Test
    fun aRemoteWithoutTheSuffixWorksJustAsWell() {
        assertEquals(
            "https://github.com/owner/repo/compare/main...feat%2Fx?expand=1",
            pullRequestUrl("https://github.com/owner/repo", "feat/x"),
        )
    }

    @Test
    fun scpStyleRemoteIsRewrittenToHttps() {
        // The form `git clone` prints for SSH: no scheme, a colon instead of the
        // first slash. Read as a URL it would have no host at all.
        assertEquals(
            "https://github.com/owner/repo/compare/main...topic?expand=1",
            pullRequestUrl("git@github.com:owner/repo.git", "topic"),
        )
    }

    @Test
    fun sshUrlRemoteIsRewrittenToo() {
        assertEquals(
            "https://gitlab.com/owner/repo/-/compare/main...topic?expand=1",
            pullRequestUrl("ssh://git@gitlab.com/owner/repo.git", "topic"),
        )
    }

    @Test
    fun gitlabUsesItsOwnCompareRoute() {
        // GitLab's compare lives under /-/compare; GitHub's does not. One shape
        // for both sent GitLab readers to a page that does not exist.
        assertEquals(
            "https://gitlab.com/owner/repo/-/compare/main...feat?expand=1",
            pullRequestUrl("https://gitlab.com/owner/repo.git", "feat"),
        )
    }

    @Test
    fun aSlashInTheBranchIsEscaped() {
        // `fix/a` unescaped would make the compare route read "fix" as the head
        // and "a" as a path segment.
        val url = pullRequestUrl("https://github.com/o/r.git", "fix/a/b")!!
        assertEquals(true, url.contains("fix%2Fa%2Fb"))
        assertEquals(false, url.contains("main...fix/a"))
    }

    @Test
    fun theDefaultBranchHasNothingToPropose() {
        assertNull(pullRequestUrl("https://github.com/o/r.git", "main"))
        assertNull(pullRequestUrl("https://github.com/o/r.git", "master", "master"))
    }

    @Test
    fun aCustomDefaultBranchIsHonoured() {
        assertEquals(
            "https://github.com/o/r/compare/develop...feat?expand=1",
            pullRequestUrl("https://github.com/o/r.git", "feat", "develop"),
        )
    }

    @Test
    fun aHostWithNoKnownCompareRouteIsRefused() {
        // Better no button than one that opens somebody's intranet root.
        assertNull(pullRequestUrl("https://git.example.local/o/r.git", "feat"))
        assertNull(pullRequestUrl("https://127.0.0.1/o/r.git", "feat"))
    }

    @Test
    fun aRemoteThatIsNotAUrlIsRefused() {
        assertNull(pullRequestUrl("", "feat"))
        assertNull(pullRequestUrl("   ", "feat"))
        assertNull(pullRequestUrl("/local/path/repo", "feat"))
        assertNull(pullRequestUrl("file:///c:/repos/r", "feat"))
        assertNull(pullRequestUrl("https://github.com/onlyowner", "feat"))
    }

    @Test
    fun aBlankBranchHasNothingToPropose() {
        assertNull(pullRequestUrl("https://github.com/o/r.git", ""))
    }

    @Test
    fun trailingSlashesDoNotDoubleUp() {
        assertEquals(
            "https://github.com/o/r/compare/main...feat?expand=1",
            pullRequestUrl("https://github.com/o/r/", "feat"),
        )
    }
}