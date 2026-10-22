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
}