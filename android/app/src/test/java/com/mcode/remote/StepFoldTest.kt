package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * How the flat transcript folds into steps.
 *
 * `rowsOf` groups adjacent tool calls into one `ToolRun`; `stepsOf` then hangs
 * those runs off the assistant prose they were made for, so a paragraph and its
 * calls draw as one move with a rule beside them.
 *
 * The reason this is worth pinning: the fold has a branch that is nearly
 * unreachable in practice - a call arriving with no assistant prose before it in
 * the same stretch - and when it is reached the row goes into the list bare. The
 * renderer has a `is Item.Tool ->` arm for that, and it had gone untested long
 * enough that I could not say from reading the code whether the arm was dead or
 * merely rare. These tests say which.
 */
class StepFoldTest {

    private fun msg(id: String, role: String, text: String = "words") =
        Item.Msg(id = id, role = role, text = text)

    private fun tool(uid: String, name: String = "read") =
        Item.Tool(uid = uid, name = name, status = "done", output = "")

    /** Two calls in a row become one run, keyed off the first. */
    @Test
    fun adjacentCallsBecomeOneRun() {
        val rows = rowsOf(listOf(tool("a"), tool("b"), tool("c")))
        assertEquals(1, rows.size)
        val run = rows[0] as ToolRun
        assertEquals(3, run.items.size)
        assertEquals("run.a", run.key)
    }

    /** A single call stays a call - one call is not a run. */
    @Test
    fun oneCallIsNotARun() {
        val rows = rowsOf(listOf(tool("a")))
        assertEquals(1, rows.size)
        assertTrue(rows[0] is Item.Tool)
    }

    /** Prose between calls splits them into two runs. */
    @Test
    fun proseBetweenCallsSplitsTheRuns() {
        val rows = rowsOf(listOf(tool("a"), msg("m1", "assistant"), tool("b")))
        assertEquals(3, rows.size)
        assertTrue(rows[0] is Item.Tool)
        assertTrue(rows[1] is Item.Msg)
        assertTrue(rows[2] is Item.Tool)
    }

    /** Calls after assistant prose hang off it as one step. */
    @Test
    fun callsAfterProseBecomeAStep() {
        val steps = stepsOf(listOf(msg("m1", "assistant"), tool("a"), tool("b")))
        assertEquals(1, steps.size)
        val step = steps[0] as Step
        assertEquals("m1", (step.body as Item.Msg).id)
        assertEquals(2, step.calls.size)
        assertEquals("step.m1", step.key)
    }

    /**
     * A call whose prose is still *ahead* of it stays its own row.
     *
     * This is the honest behaviour, not a gap: measured on a real thread on the
     * pad, every run of calls follows assistant text and none precedes it, so
     * there is no data to fold this case for. Written as an expectation of one
     * step first - which failed - and then as what the code actually does. If a
     * provider ever does send calls before their prose, this test is where the
     * change of expectation starts.
     */
    @Test
    fun aCallAheadOfItsProseStaysItsOwnRow() {
        val steps = stepsOf(listOf(tool("a"), msg("m1", "assistant")))
        assertEquals("the call keeps its own row, the prose keeps its own", 2, steps.size)
        assertTrue(steps[0] is Item.Tool)
        assertTrue(steps[1] is Item.Msg)
    }

    /**
     * A call with no assistant prose anywhere before it goes in bare.
     *
     * This is the arm that matters: nothing in this stretch can own it, so the
     * renderer's `is Item.Tool ->` branch is the one that draws it. It is rare,
     * not dead.
     */
    @Test
    fun aLeadingCallWithNoOwnerIsLeftBare() {
        val steps = stepsOf(listOf(tool("a")))
        assertEquals(1, steps.size)
        assertTrue("a lone call must stay a call, not become a Step", steps[0] is Item.Tool)
    }

    /** A user turn is never wrapped, and never adopts the calls of the reply above it. */
    @Test
    fun aUserTurnIsNeverAStep() {
        val steps = stepsOf(listOf(msg("u1", "user", "hi")))
        assertEquals(1, steps.size)
        assertTrue(steps[0] is Item.Msg)
    }

    /**
     * A user prompt followed by the assistant's calls: the calls go to the
     * assistant prose, never to the user's bubble.
     *
     * Getting this wrong puts a tool row inside the reader's own message.
     */
    @Test
    fun callsDoNotAttachToAUserTurn() {
        val steps = stepsOf(
            listOf(msg("u1", "user", "do the thing"), msg("m1", "assistant"), tool("a")),
        )
        assertEquals(2, steps.size)
        assertTrue("the user's turn stays loose", steps[0] is Item.Msg)
        val step = steps[1] as Step
        assertEquals("m1", (step.body as Item.Msg).id)
        assertEquals(1, step.calls.size)
    }

    /** Runs and bare calls are both "calls" as far as the fold is concerned. */
    @Test
    fun aRunAlsoJoinsTheStep() {
        val rows = rowsOf(listOf(msg("m1", "assistant"), tool("a"), tool("b")))
        val steps = stepsOf(rows)
        assertEquals(1, steps.size)
        val step = steps[0] as Step
        assertEquals(1, step.calls.size)
        assertTrue(step.calls[0] is ToolRun)
    }

    /**
     * Two assistant paragraphs each keep their own calls.
     *
     * The fold walks forward, so a second paragraph must start a new step rather
     * than inheriting the first one's calls.
     */
    @Test
    fun aSecondParagraphStartsItsOwnStep() {
        val steps = stepsOf(
            listOf(
                msg("m1", "assistant"), tool("a"),
                msg("m2", "assistant"), tool("b"),
            ),
        )
        assertEquals(2, steps.size)
        assertEquals(1, (steps[0] as Step).calls.size)
        assertEquals(1, (steps[1] as Step).calls.size)
    }

    /**
     * A whole exchange, in the order a real thread on the pad actually runs:
     * the assistant's words, its calls, then the reader's reply, then the next
     * assistant turn.
     *
     * Nothing may be lost in the fold. The failure this guards against is the
     * one my own scratch simulation reported - every row collapsing into a
     * single step - which turned out to be a defect in the simulation rather
     * than in the code, but the check belongs here either way. Counting the
     * rows in and the rows out is the cheapest way to say "nothing vanished".
     */
    @Test
    fun aWholeExchangeKeepsEveryRow() {
        val rows = rowsOf(
            listOf(
                msg("a1", "assistant", "let me look"),
                tool("t1", "read"), tool("t2", "grep"),
                msg("u1", "user", "thanks"),
                msg("a2", "assistant", "here it is"),
                tool("t3", "write"),
                msg("u2", "user", "again"),
                msg("a3", "assistant", "done"),
            ),
        )
        val steps = stepsOf(rows)

        // Two user turns and three assistant turns; the first two assistant
        // turns carry calls, the last has none.
        assertEquals(5, steps.size)
        assertTrue(steps[0] is Step)
        assertTrue(steps[1] is Item.Msg)
        assertTrue(steps[2] is Step)
        assertTrue(steps[3] is Item.Msg)
        assertTrue(steps[4] is Item.Msg)
        // `rowsOf` has already merged the two adjacent reads into one run, so
        // the first step carries one run of two calls rather than two calls.
        val firstCalls = (steps[0] as Step).calls
        assertEquals(1, firstCalls.size)
        assertEquals(2, (firstCalls[0] as ToolRun).items.size)
        assertEquals(1, (steps[2] as Step).calls.size)
        // and the user's words survive as their own rows
        assertEquals("u1", (steps[1] as Item.Msg).id)
        assertEquals("u2", (steps[3] as Item.Msg).id)
    }

    /**
     * A step that already owns its calls must not be raided by later prose.
     *
     * `Step` is not a call, so the walk that adopts calls sitting above the
     * words stops at the first step it meets - which is what keeps a second
     * paragraph from stealing the calls the first one already shows.
     */
    @Test
    fun aLaterParagraphDoesNotStealAnEarliersCalls() {
        val steps = stepsOf(
            listOf(msg("m1", "assistant"), tool("a"), msg("m2", "assistant")),
        )
        assertEquals(2, steps.size)
        assertEquals(1, (steps[0] as Step).calls.size)
        assertTrue("the second paragraph has no calls of its own", steps[1] is Item.Msg)
    }

    /**
     * Calls keep the order the server sent them in.
     *
     * The leading call is its own row for the reason above; the trailing one
     * joins the prose, and it is the only call in that step.
     */
    @Test
    fun theTrailingCallJoinsTheProseInOrder() {
        val rows = rowsOf(
            listOf(tool("t1", "read"), msg("m1", "assistant"), tool("t2", "write")),
        )
        /*
         * Two rows, not three: `t1` stands alone and `m1` + `t2` fold together.
         * Written as three first because I had counted the input's parts rather
         * than the output's rows.
         */
        val steps = stepsOf(rows)
        assertEquals(2, steps.size)
        assertTrue(steps[0] is Item.Tool)
        val step = steps[1] as Step
        assertEquals(1, step.calls.size)
        assertEquals("t2", (step.calls[0] as Item.Tool).uid)
    }
}
