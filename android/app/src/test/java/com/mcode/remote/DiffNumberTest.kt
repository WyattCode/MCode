package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The gutter of the diff sheet, where the side and the line number live.
 *
 * The phone's own sheet numbers every line and puts the side in front of the
 * number - `-231` on a removed line, `+231` on an added one, a bare number on
 * context (measured off `REF-diffview.png`). The renderer this replaced drew the
 * raw prefix in the body and no numbers at all, so nothing on screen said which
 * line of the file a change sat on.
 *
 * The numbering has to survive the truncation too: the slice drops the tail, but
 * it must not shift the numbers of the lines it keeps.
 */
class DiffNumberTest {

    private val patch = """
        |--- a/f.txt
        |+++ b/f.txt
        |@@ -10,4 +10,5 @@
        | context one
        |-old line
        |+new one
        |+new two
      """.trimMargin()

    @Test
    fun aHugeLimitDoesNotWrapIntoANegative() {
        // `diffSlice` peeks at maxLines + 1. Passing Int.MAX_VALUE - which this
        // renderer did, to count every line - wraps that to Int.MIN_VALUE, and
        // `take` throws on a negative count. Inside a composable's `remember`
        // that took the whole screen down, so an "unlimited" request was the one
        // request that could not be served.
        val (lines, hidden) = diffWithNumbers("@@ -1,1 +1,1 @@\n+a\n", Int.MAX_VALUE)
        assertEquals(2, lines.size)
        assertEquals(0, hidden)
    }

    @Test
    fun aHunkStartsAtTheNumbersInItsHeader() {
        val (lines, _) = diffWithNumbers(patch, 80)
        // The header itself carries no number.
        assertNull(lines[2].number)
        // The first context line is old 10 / new 10.
        assertEquals(10, lines[3].number)
        assertEquals(3, lines[3].side)
    }

    @Test
    fun aRemovedLineTakesTheOldNumber() {
        val (lines, _) = diffWithNumbers(patch, 80)
        val removed = lines.first { it.side == 2 }
        assertEquals(11, removed.number)
        assertEquals("old line", removed.text)
    }

    @Test
    fun addedLinesCountUpOnTheNewSideOnly() {
        val (lines, _) = diffWithNumbers(patch, 80)
        val added = lines.filter { it.side == 1 }
        assertEquals(listOf(11, 12), added.map { it.number })
        assertEquals(listOf("new one", "new two"), added.map { it.text })
    }

    @Test
    fun theRemovalDoesNotConsumeANewLine() {
        val (lines, _) = diffWithNumbers(patch, 80)
        // After "-old line" (old 11) and "+new one" (new 11) the next added line
        // is new 12, not 13: a removal advances only the old side.
        assertEquals(12, lines.last().number)
    }

    @Test
    fun theFileHeaderIsNotCountedAsALine() {
        val (lines, _) = diffWithNumbers(patch, 80)
        assertNull(lines[0].number)
        assertNull(lines[1].number)
        // Its text is kept whole, prefix included, so it still reads as a header.
        assertEquals("--- a/f.txt", lines[0].text)
    }

    @Test
    fun aSecondHunkResetsTheCounters() {
        val two = """
            |@@ -1,1 +1,1 @@
            |-a
            |+b
            |@@ -40,1 +40,1 @@
            |-c
            |+d
        """.trimMargin()
        val (lines, _) = diffWithNumbers(two, 80)
        // lines[3] is the second hunk's header, which carries no number of its
        // own; the counters it resets first apply to the line after it.
        assertNull(lines[3].number)
        assertEquals(40, lines[4].number)
        assertEquals(40, lines[5].number)
        assertEquals(1, lines[1].number)
    }

    @Test
    fun truncationDoesNotDisturbTheNumbersItKeeps() {
        val long = (listOf("@@ -1,10 +1,10 @@") + (1..10).map { "+line $it" }).joinToString("\n")
        val (all, _) = diffWithNumbers(long, 80)
        val (cut, hidden) = diffWithNumbers(long, 4)
        assertEquals(7, hidden)
        assertEquals(all.take(4).map { it.number }, cut.map { it.number })
    }

    @Test
    fun aTrailingNewlineDoesNotBecomeANumberedLine() {
        // "a\n" reads as two lines to `lineSequence` - the second empty. A patch
        // always ends with a newline, so drawn as-is the phantom was a numbered
        // blank row hanging off the end of every patch.
        val (lines, hidden) = diffWithNumbers("@@ -1,1 +1,1 @@\n+a\n", 80)
        assertEquals(2, lines.size)
        assertEquals(listOf<Int?>(null, 1), lines.map { it.number })
        assertEquals(0, hidden)
    }

    @Test
    fun aBlankContextLineKeepsTheSpaceAfterThePrefix() {
        // A context line of only whitespace is " " in the patch - stripping the
        // prefix must leave it empty, not leave it with the space.
        val (lines, _) = diffWithNumbers("@@ -1,1 +1,1 @@\n \n", 80)
        assertEquals("", lines[1].text)
        assertEquals(1, lines[1].number)
    }

    @Test
    fun additionsOnlyStartAtOneWhenTheHunkSaysSo() {
        val created = """
            |--- /dev/null
            |+++ b/new.md
            |@@ -0,0 +1,2 @@
            |+# one
            |+# two
        """.trimMargin()
        val (lines, _) = diffWithNumbers(created, 80)
        val added = lines.filter { it.side == 1 }
        assertEquals(listOf(1, 2), added.map { it.number })
    }
}