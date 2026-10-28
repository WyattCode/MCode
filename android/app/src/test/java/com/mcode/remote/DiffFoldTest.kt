package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The sheet does not print a hundred unchanged lines to reach one change.
 *
 * Measured off `REF-diffview.png`: 「+227 行」 on a blue plate, and the lines
 * below it begin at 228 - the count is the context run skipped, and what
 * survives is the last three of it. Without the fold a change at line 231 put the
 * change itself below the bottom of the screen, which is the one thing the sheet
 * exists to show.
 */
class DiffFoldTest {

    private fun hunk(context: Int, tail: Int = 1): String = buildString {
        append("@@ -1,${context + 1} +1,${context + 1} @@\n")
        repeat(context) { append(" line $it\n") }
        repeat(tail) { append("+changed\n") }
    }

    @Test
    fun aLongRunOfContextIsFolded() {
        val (rows, _) = sheetRows(hunk(40), 400)
        assertEquals("a fold stands in for the run", 1, rows.count { it is SheetRow.Fold })
    }

    @Test
    fun theFoldCountsWhatItHides() {
        // 40 context lines before the change. There is nothing above them to be
        // near, so only the three next to the change survive and 37 are hidden.
        val (rows, _) = sheetRows(hunk(40), 400)
        val fold = rows.filterIsInstance<SheetRow.Fold>().single()
        assertEquals(37, fold.skipped)
    }

    @Test
    fun threeLinesSurviveOnTheChangeSide() {
        val (rows, _) = sheetRows(hunk(40), 400)
        val foldAt = rows.indexOfFirst { it is SheetRow.Fold }
        val after = rows.drop(foldAt + 1).filterIsInstance<SheetRow.Line>()
            .filter { it.line.side == 3 }
        assertEquals("the window next to the change is three", 3, after.size)
        // And it is the *last* three of the run, not the first: lines 38, 39, 40
        // of a hunk starting at 1.
        assertEquals(38, after.first().line.number)
    }

    @Test
    fun aShortRunIsLeftAlone() {
        // Six lines is the two windows plus nothing to hide - a bar would cost
        // more attention than the lines it replaces.
        val (rows, _) = sheetRows(hunk(6), 400)
        assertEquals(0, rows.count { it is SheetRow.Fold })
    }

    @Test
    fun sevenLinesIsTheFirstRunWorthFolding() {
        // Seven unchanged lines, three of them kept next to the change: four to
        // hide. Six would hide none, and a bar saying "+0 行" is worse than the
        // lines.
        val (rows, _) = sheetRows(hunk(7), 400)
        assertEquals(1, rows.count { it is SheetRow.Fold })
        assertEquals(4, rows.filterIsInstance<SheetRow.Fold>().single().skipped)
    }

    @Test
    fun aRunInTheMiddleKeepsThreeOnEachSide() {
        val patch = buildString {
            append("@@ -1,20 +1,20 @@\n")
            append("+first\n")
            repeat(20) { append(" line $it\n") }
            append("+last\n")
        }
        val (rows, _) = sheetRows(patch, 400)
        val fold = rows.filterIsInstance<SheetRow.Fold>().single()
        assertEquals("20 lines, three either side", 14, fold.skipped)
        // Three unchanged lines still separate the first change from the bar.
        val firstFold = rows.indexOfFirst { it is SheetRow.Fold }
        assertEquals(3, rows.take(firstFold).count { it is SheetRow.Line && it.line.side == 3 })
    }

    @Test
    fun addedLinesAreNeverFolded() {
        val patch = buildString {
            append("@@ -1,1 +1,30 @@\n")
            repeat(30) { append("+line $it\n") }
        }
        val (rows, _) = sheetRows(patch, 400)
        assertEquals(0, rows.count { it is SheetRow.Fold })
        assertEquals(30, rows.filterIsInstance<SheetRow.Line>().count { it.line.side == 1 })
    }

    @Test
    fun theRowsStillAddUpToTheSlice() {
        // Every line is either drawn or counted by a fold - nothing lost silently.
        val (rows, hidden) = sheetRows(hunk(40), 400)
        val drawn = rows.count { it is SheetRow.Line }
        val folded = rows.filterIsInstance<SheetRow.Fold>().sumOf { it.skipped }
        assertEquals(0, hidden)
        assertEquals(42, drawn + folded) // hunk header + 40 context + 1 change
    }
}