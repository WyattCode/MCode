package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The selection's arithmetic, locked down.
 *
 * These are the two mistakes that cost the most time in this file, written as
 * tests so they cannot come back silently:
 *
 *  - a slice was handed its block's offset in the reply instead of its offset
 *    *within* the block, which made every paragraph's slice start past its own
 *    end and nothing could be selected at all;
 *  - `Int.MAX_VALUE` stood for "through the end of this block", and adding it to
 *    a base offset wrapped round to a negative number, so the copied range
 *    started after it ended.
 *
 * Both are offset arithmetic and both are answerable without a device.
 */
class SelectionSliceTest {

    /** A paragraph: one `Text` holding the whole block. */
    @Test
    fun wholeBlockFromTheStart() {
        assertEquals(0 to 5, sliceOfSelection(0, 5, sliceStart = 0, length = 5))
    }

    /** A paragraph selected from the middle of its second word. */
    @Test
    fun partOfABlock() {
        assertEquals(3 to 7, sliceOfSelection(3, 7, sliceStart = 0, length = 20))
    }

    /**
     * The bug: a paragraph whose `sliceStart` had been given the block's offset
     * in the reply. Its own selection then had nothing to overlap.
     */
    @Test
    fun aSliceOffsetPastItsOwnEndHasNothingToShow() {
        // Block of 20 characters, selection 0..5, but the slice was handed 120.
        assertNull(sliceOfSelection(0, 5, sliceStart = 120, length = 20))
    }

    /** Three of a list's items: each is a slice of the same block. */
    @Test
    fun eachItemTakesItsOwnPart() {
        // "alpha\nbeta\ngamma" - items begin at 0, 6 and 11.
        val text = "alpha\nbeta\ngamma"
        assertEquals(0 to 5, sliceOfSelection(0, 5, sliceStart = 0, length = 5))
        assertEquals(0 to 4, sliceOfSelection(6, 16, sliceStart = 6, length = 4))
        assertEquals(0 to 5, sliceOfSelection(6, 16, sliceStart = 11, length = 5))
    }

    /** A middle item of a list: the selection runs past both of its own ends. */
    @Test
    fun aMiddleItemIsEntirelyLit() {
        assertEquals(0 to 4, sliceOfSelection(2, 15, sliceStart = 6, length = 4))
    }

    /**
     * The other bug: `Int.MAX_VALUE` as the open end.
     *
     * This used to be added to the slice's start and wrapped to a negative,
     * which produced a range that started after it ended - so the copy chip had
     * no text and the wash covered nothing.
     */
    @Test
    fun anOpenEndMeansThroughTheSlice() {
        assertEquals(3 to 20, sliceOfSelection(3, Int.MAX_VALUE, sliceStart = 0, length = 20))
    }

    /** An open end on a slice that starts late in the block still fills it. */
    @Test
    fun anOpenEndOnALaterSlice() {
        assertEquals(0 to 8, sliceOfSelection(11, Int.MAX_VALUE, sliceStart = 11, length = 8))
    }

    /** A slice entirely before the selection has nothing. */
    @Test
    fun aSliceBeforeTheSelection() {
        assertNull(sliceOfSelection(30, 40, sliceStart = 0, length = 10))
    }

    /** A slice entirely after the selection has nothing. */
    @Test
    fun aSliceAfterTheSelection() {
        assertNull(sliceOfSelection(0, 5, sliceStart = 10, length = 10))
    }

    /**
     * A selection reaching past a slice's end stops at that end.
     *
     * The block runs 5..100 but this slice only owns 10..20, so it is lit from
     * its first character to its last and no further.
     */
    @Test
    fun aSelectionReachingPastTheSliceStopsAtItsEnd() {
        assertEquals(0 to 10, sliceOfSelection(5, 100, sliceStart = 10, length = 10))
    }

    /** An empty slice is never selected, however wide the selection. */
    @Test
    fun anEmptySliceIsNeverLit() {
        assertNull(sliceOfSelection(0, 50, sliceStart = 0, length = 0))
    }

    /** A collapsed selection - a press that has not moved - lights nothing. */
    @Test
    fun aCollapsedSelectionLightsNothing() {
        assertNull(sliceOfSelection(4, 4, sliceStart = 0, length = 20))
    }

    /** A selection that ends before it starts can only come from a bug; it lights nothing. */
    @Test
    fun aBackwardsRangeLightsNothing() {
        assertNull(sliceOfSelection(9, 3, sliceStart = 0, length = 20))
    }

    /* ------------------------------------------------------------------ */
    /* The copy range, where the wrap-around actually happened              */
    /* ------------------------------------------------------------------ */

    /** A word inside one paragraph: block offset 6 in, 10 characters long. */
    @Test
    fun aWordInsideOneBlock() {
        // Block 2 begins at 120 of the reply; the word is 6..10 within it.
        assertEquals(126 to 130, copyRange(120, 6, 120, 10, plainLength = 400))
    }

    /**
     * The wrap-around.
     *
     * A drag past the end of a block leaves `Int.MAX_VALUE` in the end offset.
     * Adding that to the block's own position in `Int` produced a negative
     * number, so the range began after it ended and the copy chip came back
     * empty. With the addition done in `Long` and saturated, it simply reaches
     * the end of the reply.
     */
    @Test
    fun anOpenEndReachesTheEndRatherThanWrapping() {
        assertEquals(120 to 400, copyRange(120, 0, 120, Int.MAX_VALUE, plainLength = 400))
    }

    /** An end that points past the text is clamped, not thrown. */
    @Test
    fun anEndPastTheTextIsClamped() {
        assertEquals(390 to 400, copyRange(380, 10, 380, 900, plainLength = 400))
    }

    /** A start past the end of the reply clamps to its length, giving nothing. */
    @Test
    fun aStartPastTheTextHasNothingToCopy() {
        assertNull(copyRange(500, 0, 500, 10, plainLength = 400))
    }

    /** Two blocks: the range covers the gap between them as well. */
    @Test
    fun acrossTwoBlocks() {
        // Block 1 at 0, block 2 at 60; from 10 in the first to 5 in the second.
        assertEquals(10 to 65, copyRange(0, 10, 60, 5, plainLength = 400))
    }

    /** A press that has not moved copies nothing. */
    @Test
    fun aCollapsedCopyRange() {
        assertNull(copyRange(60, 5, 60, 5, plainLength = 400))
    }

    /* ------------------------------------------------------------------ */
    /* A table's cells, which are offsets inside a two-dimensional block    */
    /* ------------------------------------------------------------------ */

    /**
     * A two-column table: `a b\ncc dd`.
     *
     * The head's cells start at 0 and 2 - one space between them, which belongs
     * to neither. The flat text is `a` `space` `b` `newline` `c` `c` ... so the
     * newline is at 3 and the first row's cells start at 4 and 7.
     */
    @Test
    fun aTwoColumnTable() {
        val starts = tableCellStarts(
            head = listOf("a", "b"),
            rows = listOf(listOf("cc", "dd")),
            columns = 2,
        )
        assertEquals(listOf(0, 2), starts[0].toList())
        assertEquals(listOf(4, 7), starts[1].toList())

        // The same offsets read back out of the real flat string.
        val flat = (listOf(listOf("a", "b")) + listOf(listOf("cc", "dd")))
            .joinToString("\n") { it.joinToString(" ") }
        assertEquals("a b\ncc dd", flat)
        assertEquals("cc", flat.substring(4, 6))
        assertEquals("dd", flat.substring(7, 9))
    }

    /**
     * The separators are what a wrong version gets wrong.
     *
     * Folding the space or the newline into a cell's length puts every cell
     * after the first one character to the right, which selects the wrong word -
     * visibly so, but only on a device. Asserting the flat text's own character
     * at each offset makes the separators explicit: they are spaces and
     * newlines, and no cell claims them.
     */
    @Test
    fun theSeparatorsBelongToNoCell() {
        val head = listOf("ab", "cd")
        val rows = listOf(listOf("ef", "gh"))
        val flat = (listOf(head) + rows).joinToString("\n") { it.joinToString(" ") }
        val starts = tableCellStarts(head, rows, columns = 2)

        // Reconstruct each cell from the flat text and check it back.
        assertEquals("ab", flat.substring(starts[0][0], starts[0][0] + 2))
        assertEquals("cd", flat.substring(starts[0][1], starts[0][1] + 2))
        assertEquals("ef", flat.substring(starts[1][0], starts[1][0] + 2))
        assertEquals("gh", flat.substring(starts[1][1], starts[1][1] + 2))

        // And the two separators really are where they should be.
        assertEquals(' ', flat[starts[0][1] - 1])
        assertEquals('\n', flat[starts[1][0] - 1])
    }

    /** A short row: the missing cell gets no characters of its own. */
    @Test
    fun aShortRowPadsItsMissingCells() {
        val head = listOf("a", "b", "c")
        val rows = listOf(listOf("x"))
        val starts = tableCellStarts(head, rows, columns = 3)
        val flat = (listOf(head) + rows).joinToString("\n") { it.joinToString(" ") }
        assertEquals("a b c\nx", flat)
        // Head: a at 0, b at 2, c at 4.
        assertEquals(listOf(0, 2, 4), starts[0].toList())
        // The row's only cell starts at 6; the two it does not have collapse on
        // their end, so they own nothing and can never be lit.
        assertEquals(6, starts[1][0])
        assertEquals("x", flat.substring(6, 7))
        assertEquals(7, starts[1][1])
        assertEquals(7, starts[1][2])
    }

    /** A cell that owns no characters can never be lit, however wide the selection. */
    @Test
    fun aMissingCellIsNeverLIT() {
        val starts = tableCellStarts(
            head = listOf("a", "b"),
            rows = listOf(listOf("x")),
            columns = 2,
        )
        // The second cell of the row has start 7 and length 0.
        assertNull(sliceOfSelection(0, 50, sliceStart = starts[1][1], length = 0))
    }

    /** Three rows: each newline is accounted for exactly once. */
    @Test
    fun threeRowsAdvanceByTheirOwnLengths() {
        val head = listOf("h")
        val rows = listOf(listOf("a"), listOf("bb"))
        val starts = tableCellStarts(head, rows, columns = 1)
        val flat = (listOf(head) + rows).joinToString("\n") { it.joinToString(" ") }
        assertEquals("h\na\nbb", flat)
        // h at 0, newline at 1, a at 2, newline at 3, bb at 4.
        assertEquals(0, starts[0][0])
        assertEquals(2, starts[1][0])
        assertEquals(4, starts[2][0])
        assertEquals("h", flat.substring(0, 1))
        assertEquals("a", flat.substring(2, 3))
        assertEquals("bb", flat.substring(4, 6))
    }

    /** The whole table's flat length matches the last cell plus the trailing newline. */
    @Test
    fun theTableMatchesItsOwnFlatText() {
        val head = listOf("名字", "值")
        val rows = listOf(listOf("甲", "1"), listOf("乙", "2"))
        val flat = (listOf(head) + rows).joinToString("\n") { it.joinToString(" ") }
        val starts = tableCellStarts(head, rows, columns = 2)
        // Every cell's slice must land on its own text when read from `flat`.
        for (r in starts.indices) {
            val cells = if (r == 0) head else rows[r - 1]
            for (c in cells.indices) {
                val from = starts[r][c]
                assertEquals(cells[c], flat.substring(from, from + cells[c].length))
            }
        }
    }
}