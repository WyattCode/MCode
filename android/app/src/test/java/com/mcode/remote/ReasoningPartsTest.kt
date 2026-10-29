package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * How the reasoning store holds a turn's thinking.
 *
 * The fold is only as good as this store: it has to keep the longer of a
 * snapshot and what it already holds (the cockpit's `deltas` rule), append
 * streamed fragments, and join parts in arrival order without ever leaking
 * into the reply text. These tests pin those rules so a later change to the
 * streaming path cannot quietly drop the thinking again.
 */
class ReasoningPartsTest {

    /** Nothing held yet: no fold, no count. */
    @Test
    fun emptyStart() {
        val r = ReasoningParts()
        assertEquals("", r.joined("m1"))
        assertEquals(0, r.charCount("m1"))
    }

    /** A snapshot followed by a delta grows the held text. */
    @Test
    fun snapshotThenDeltaGrows() {
        val r = ReasoningParts()
        r.putSnapshot("m1", "p1", "先想")
        r.appendDelta("m1", "p1", "一步")
        assertEquals("先想一步", r.joined("m1"))
    }

    /** A shorter snapshot must not shrink what is already held. */
    @Test
    fun shorterSnapshotDoesNotShrink() {
        val r = ReasoningParts()
        r.putSnapshot("m1", "p1", "先想一步")
        r.putSnapshot("m1", "p1", "先想")
        assertEquals("先想一步", r.joined("m1"))
    }

    /** One message's reasoning never appears under another. */
    @Test
    fun joinedNeverIncludesUnrelated() {
        val r = ReasoningParts()
        r.putSnapshot("m1", "p1", "甲")
        r.putSnapshot("m2", "p2", "乙")
        assertEquals("甲", r.joined("m1"))
        assertEquals("乙", r.joined("m2"))
    }

    /** Parts join in arrival order, not by id. */
    @Test
    fun multiplePartsKeepArrivalOrder() {
        val r = ReasoningParts()
        r.putSnapshot("m1", "p2", "第二")
        r.putSnapshot("m1", "p1", "第一")
        assertEquals("第二\n\n第一", r.joined("m1"))
    }

    /** A session switch wipes the store. */
    @Test
    fun clearEmptiesEverything() {
        val r = ReasoningParts()
        r.putSnapshot("m1", "p1", "甲")
        r.clear()
        assertEquals("", r.joined("m1"))
        assertEquals(0, r.charCount("m1"))
    }

    /** The count is the joined length, so the fold and `thinkOnly` agree. */
    @Test
    fun charCountTracksJoined() {
        val r = ReasoningParts()
        r.putSnapshot("m1", "p1", "甲乙")
        r.appendDelta("m1", "p1", "丙")
        assertEquals(r.joined("m1").length, r.charCount("m1"))
    }

    /** An announced-but-empty part leaves no visible content. */
    @Test
    fun blankSnapshotCreatesNothingVisible() {
        val r = ReasoningParts()
        r.putSnapshot("m1", "p1", "")
        assertEquals("", r.joined("m1"))
        assertEquals(0, r.charCount("m1"))
    }
}
