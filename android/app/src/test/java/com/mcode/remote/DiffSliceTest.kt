package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a patch card shows, and what it admits to hiding.
 *
 * The card truncates at 80 lines by default. Across the 47 patches in this
 * machine's transcripts the median is 15 lines, but one runs to 99 - so the cut
 * is not hypothetical, and before this fix the tail simply vanished with no sign
 * that anything had been left out.
 */
class DiffSliceTest {

    private fun patch(n: Int): String =
        (1..n).joinToString("\n") { "line $it" }

    @Test
    fun aShortPatchIsDrawnWhole() {
        val (shown, hidden) = diffSlice(patch(15), 80)
        assertEquals(15, shown.size)
        assertEquals("nothing is behind the fold", 0, hidden)
    }

    @Test
    fun aPatchAtExactlyTheLimitIsNotCut() {
        val (shown, hidden) = diffSlice(patch(80), 80)
        assertEquals(80, shown.size)
        assertEquals("80 of 80 leaves nothing over", 0, hidden)
    }

    @Test
    fun oneLinePastTheLimitIsReportedAsOne() {
        val (shown, hidden) = diffSlice(patch(81), 80)
        assertEquals(80, shown.size)
        assertEquals(1, hidden)
    }

    @Test
    fun theLongestPatchOnThisMachineSaysWhatItHides() {
        // 99 is the real maximum among the transcripts on this machine.
        val (shown, hidden) = diffSlice(patch(99), 80)
        assertEquals(80, shown.size)
        assertEquals(19, hidden)
    }

    @Test
    fun aLineWithNoNewlineAtTheEndIsCounted() {
        val (shown, hidden) = diffSlice("a\nb\nc", 2)
        assertEquals(listOf("a", "b"), shown)
        assertEquals(1, hidden)
    }

    @Test
    fun anEmptyPatchDrawsNothing() {
        val (shown, hidden) = diffSlice("", 80)
        assertTrue("an empty patch still yields its one empty line", shown.size <= 1)
        assertEquals(0, hidden)
    }

    @Test
    fun aLimitOfZeroShowsNothingAndCountsAll() {
        val (shown, hidden) = diffSlice(patch(5), 0)
        assertTrue(shown.isEmpty())
        assertEquals(5, hidden)
    }

    @Test
    fun theShownLinesAreTheFirstOnesInOrder() {
        val (shown, _) = diffSlice((1..10).joinToString("\n") { "L$it" }, 3)
        assertEquals(listOf("L1", "L2", "L3"), shown)
    }

    @Test
    fun aRealUnifiedDiffKeepsItsHeaderLines() {
        val real = """
            |--- a/repair-backups/peilian-v5b/当前状态.md
            |+++ b/repair-backups/peilian-v5b/当前状态.md
            |@@ -1,0 +1,41 @@
            |+# 当前状态（2026-09-26 晚核对）
            |+
        """.trimMargin()
        val (shown, hidden) = diffSlice(real, 80)
        assertEquals(5, shown.size)
        assertTrue("the hunk header survives the slice", shown[2].startsWith("@@"))
        assertEquals(0, hidden)
    }
}