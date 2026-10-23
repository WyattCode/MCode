package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    /* ------------------------------------------------------------------ */
    /* Which end a press grabs                                             */
    /* ------------------------------------------------------------------ */

    /** A press left of the selection takes the start. */
    @Test
    fun aPressBeforeTheSelectionTakesTheStart() {
        assertFalse(nearerEndIsEnd(2, 10, 2, 20, line = 2, offset = 5))
    }

    /** A press right of the selection takes the end. */
    @Test
    fun aPressAfterTheSelectionTakesTheEnd() {
        assertTrue(nearerEndIsEnd(2, 10, 2, 20, line = 2, offset = 30))
    }

    /** Inside, the nearer end wins - and the tie goes to the end, which is what makes a tap extend rather than rewind. */
    @Test
    fun insideTheNearerEndWins() {
        assertFalse(nearerEndIsEnd(2, 10, 2, 20, line = 2, offset = 12))
        assertTrue(nearerEndIsEnd(2, 10, 2, 20, line = 2, offset = 18))
        assertTrue(nearerEndIsEnd(2, 10, 2, 20, line = 2, offset = 15))
    }

    /**
     * The bug this replaced: two ends in the *same* block.
     *
     * Every cell of a table shares one block index, so a comparator that weighted
     * the block number gave both ends the same block term and the decision fell
     * to whichever was listed first - the far handle could not be grabbed.
     */
    @Test
    fun twoEndsInOneBlockAreJudgedByOffsetAlone() {
        // Same block, cells at 0 and 120 in the table's flat text.
        assertFalse(nearerEndIsEnd(3, 0, 3, 120, line = 3, offset = 8))
        assertTrue(nearerEndIsEnd(3, 0, 3, 120, line = 3, offset = 115))
    }

    /** A press in a block before the start takes the start. */
    @Test
    fun aPressInAnEarlierBlockTakesTheStart() {
        assertFalse(nearerEndIsEnd(5, 0, 7, 10, line = 4, offset = 900))
    }

    /** A press in a block after the end takes the end. */
    @Test
    fun aPressInALaterBlockTakesTheEnd() {
        assertTrue(nearerEndIsEnd(5, 0, 7, 10, line = 8, offset = 0))
    }

    /** A block strictly between the two ends is a drag in progress: it extends the end. */
    @Test
    fun aBlockBetweenTheEndsExtendsTheEnd() {
        assertTrue(nearerEndIsEnd(5, 0, 7, 10, line = 6, offset = 3))
    }

    /**
     * Ends in different blocks are not compared by their offsets.
     *
     * A start at offset 90 of block 5 and an end at offset 4 of block 7: a press
     * at offset 50 of block 5 must be nearer the start even though 50 is a larger
     * number than 4 - the two offsets are in different strings and comparing them
     * directly would be nonsense.
     */
    @Test
    fun endsInDifferentBlocksDoNotCompareOffsetsDirectly() {
        assertFalse(nearerEndIsEnd(5, 90, 7, 4, line = 5, offset = 50))
        assertTrue(nearerEndIsEnd(5, 90, 7, 4, line = 7, offset = 20))
    }

    /* ------------------------------------------------------------------ */
    /* Grabbing a handle                                                   */
    /* ------------------------------------------------------------------ */

    /** A press dead on the disc grabs it. */
    @Test
    fun aPressOnTheCentreHits() {
        assertTrue(hitsHandle(100f, 200f, 100f, 200f, radius = 45f))
    }

    /**
     * The touch region is wider than the disc on purpose.
     *
     * The disc is 25.2 dp across - a 12.6 dp radius - but the region a press can
     * land in is 18 dp, which is the 36 dp diameter the platform asks for. A hit
     * test that used the drawn radius would make the handles feel broken on a
     * real fingertip, which is why the two numbers are separate.
     */
    @Test
    fun theTouchRegionIsWiderThanTheDisc() {
        // 15 dp from the centre: outside a 12.6 dp disc, inside an 18 dp region.
        assertTrue(hitsHandle(115f, 200f, 100f, 200f, radius = 18f))
    }

    /** Just inside the reach. */
    @Test
    fun justInsideTheReachHits() {
        assertTrue(hitsHandle(100f, 217.9f, 100f, 200f, radius = 18f))
    }

    /** Just outside the reach does not. */
    @Test
    fun justOutsideTheReachMisses() {
        assertFalse(hitsHandle(100f, 218.1f, 100f, 200f, radius = 18f))
    }

    /** The region is round, not square: a corner of the bounding box misses. */
    @Test
    fun theRegionIsRoundNotSquare() {
        // 13,13 from the centre is 18.4 away - outside an 18 radius, though both
        // components are individually inside it.
        assertFalse(hitsHandle(113f, 213f, 100f, 200f, radius = 18f))
    }

    /** A press on the other side of the screen misses. */
    @Test
    fun aDistantPressMisses() {
        assertFalse(hitsHandle(500f, 900f, 100f, 200f, radius = 45f))
    }

    /* ------------------------------------------------------------------ */
    /* Stepping out of a surface while dragging                            */
    /* ------------------------------------------------------------------ */

    /** Inside the surface: no step, the offset comes from the position. */
    @Test
    fun insideTheSurfaceDoesNotStep() {
        assertEquals(0, dragSteps(y = 50f, height = 100f, lineHeight = 30f))
        assertEquals(0, dragSteps(y = 0f, height = 100f, lineHeight = 30f))
        assertEquals(0, dragSteps(y = 100f, height = 100f, lineHeight = 30f))
    }

    /**
     * The unit is a line, not the whole `Text`.
     *
     * A three-line paragraph is 90 tall in 30 lines. Pulling 40 above its top
     * crosses one full line of travel past the edge, so two blocks: the edge
     * itself is the first, and each further 30 is another. With the old unit -
     * the whole 90-tall `Text` - the same pull would have jumped several blocks
     * at once, and a short pull would have overshot.
     */
    @Test
    fun aShortPullPastTheTopStepsOncePerLine() {
        // 1 above the edge: still the first block back only.
        assertEquals(-1, dragSteps(y = -1f, height = 90f, lineHeight = 30f))
        // 30 above: one full line past the edge, so two.
        assertEquals(-2, dragSteps(y = -30f, height = 90f, lineHeight = 30f))
        assertEquals(-2, dragSteps(y = -40f, height = 90f, lineHeight = 30f))
        assertEquals(-3, dragSteps(y = -75f, height = 90f, lineHeight = 30f))
    }

    /** Just past the bottom edge is already the next block. */
    @Test
    fun justPastTheBottomIsOneBlock() {
        assertEquals(1, dragSteps(y = 101f, height = 100f, lineHeight = 30f))
        // 30 past the edge is a full line of travel beyond the first block.
        assertEquals(2, dragSteps(y = 130f, height = 100f, lineHeight = 30f))
    }

    /** Further down adds one per line of travel past the edge. */
    @Test
    fun furtherPastTheBottomAddsLines() {
        assertEquals(2, dragSteps(y = 131f, height = 100f, lineHeight = 30f))
        assertEquals(3, dragSteps(y = 161f, height = 100f, lineHeight = 30f))
    }

    /** A zero line height cannot be divided by; it must not step or throw. */
    @Test
    fun aZeroLineHeightDoesNotStep() {
        assertEquals(0, dragSteps(y = 999f, height = 100f, lineHeight = 0f))
    }

    /* ------------------------------------------------------------------ */
    /* Ranges handed to the layout                                         */
    /* ------------------------------------------------------------------ */

    /**
     * The crash: 全选 on a 103-character block.
     *
     * The end of a range is exclusive, so "through the last character" is 103 -
     * one past the last offset `getBoundingBox` accepts. It threw
     * `offset(103) is out of bounds [0, 103)` inside `drawBehind`, which brought
     * the app down. The clamp turns that into 102.
     */
    @Test
    fun anEndAtTheLengthIsPulledBackToOneCharacter() {
        assertEquals(0..102, clampToLayout(0 until 103, length = 103))
    }

    /** An ordinary range inside the text is untouched. */
    @Test
    fun anOrdinaryRangeIsUntouched() {
        assertEquals(3..7, clampToLayout(3..7, length = 103))
    }

    /** A range running past the end stops at the last character. */
    @Test
    fun aRangePastTheEndStopsAtTheLastCharacter() {
        assertEquals(90..102, clampToLayout(90..500, length = 103))
    }

    /** A single character in the middle stays one character. */
    @Test
    fun oneCharacter() {
        assertEquals(5..5, clampToLayout(5..5, length = 103))
    }

    /** An empty layout has nothing to draw. */
    @Test
    fun anEmptyTextHasNothingToDraw() {
        assertNull(clampToLayout(0..0, length = 0))
    }

    /** A backwards range draws nothing rather than throwing. */
    @Test
    fun aBackwardsRangeDrawsNothing() {
        assertNull(clampToLayout(9..3, length = 103))
    }

    /** Everything past the end collapses to the last character, not to nothing. */
    @Test
    fun aRangeWhollyPastTheEndCollapses() {
        assertEquals(102..102, clampToLayout(200..300, length = 103))
    }
}