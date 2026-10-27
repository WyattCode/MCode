seq = "AATTAATTTAATTAAAAAAATTTTTATTATATTATATATATAATTAAAATTTTATAAAAAAAAATTTTAATA"
lines = []
for i, ch in enumerate(seq):
    if ch == 'U':
        lines.append('                msg("u%d", "user", "q%d"),' % (i, i))
    elif ch == 'A':
        lines.append('                msg("a%d", "assistant", "w%d"),' % (i, i))
    else:
        lines.append('                tool("t%d", "%s"),' % (i, "read" if i % 3 == 0 else ("grep" if i % 3 == 1 else "write")))

body = "\n".join(lines)

test = '''package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The fold, run over the exact shape of a real thread.
 *
 * `sequence` is not invented: it is the order of the text and tool parts in a
 * transcript that is on the pad right now - 72 parts, 33 of them calls, starting
 * AATTAATT... The point of replaying it verbatim is that the earlier fold passed
 * a handful of hand-made cases while failing on this order, where a call arrives
 * immediately *before* the words that explain it. Sixteen such runs exist in
 * that thread.
 *
 * Two things have to hold whatever the shape: nothing disappears, and no call
 * ends up attached to the reader's own turn.
 */
class StepFoldRealThreadTest {

    private val sequence = "%s"

    private fun rows(): List<Any> {
        val items = mutableListOf<Item>()
        for ((i, ch) in sequence.withIndex()) {
            items.add(
                when (ch) {
                    'U' -> Item.Msg(id = "u$i", role = "user", text = "q$i")
                    'A' -> Item.Msg(id = "a$i", role = "assistant", text = "w$i")
                    else -> Item.Tool(uid = "t$i", name = "read", status = "done", output = "")
                },
            )
        }
        return rowsOf(items)
    }

    /**
     * Nothing is lost: every user turn survives as its own row, and every call
     * is still inside some step or row.
     */
    @Test
    fun everyRowSurvivesTheFold() {
        val folded = stepsOf(rows())
        val users = sequence.count { it == 'U' }
        val calls = sequence.count { it == 'T' }

        val userRows = folded.count { it is Item.Msg && (it as Item.Msg).role == "user" }
        assertEquals("every user turn keeps its own row", users, userRows)

        var callsSeen = 0
        for (row in folded) {
            when (row) {
                is Step -> for (c in row.calls) {
                    callsSeen += if (c is Item.Tool) 1 else (c as ToolRun).items.size
                }
                is Item.Tool -> callsSeen += 1
                is ToolRun -> callsSeen += row.items.size
                is Item.Msg -> if (row.role != "user") {
                    // assistant prose carries no calls of its own
                }
            }
        }
        assertEquals("every call is still somewhere", calls, callsSeen)
    }

    /** No tool row may sit inside a user turn. */
    @Test
    fun noCallIsAttachedToAUserTurn() {
        val folded = stepsOf(rows())
        for (row in folded) {
            if (row is Step) {
                assertTrue(
                    "a step's body must not be the reader's own turn",
                    (row.body as? Item.Msg)?.role != "user",
                )
            }
        }
    }

    /**
     * The fold actually folds: this thread must produce far more steps than the
     * handful the old code managed, which left sixteen call-before-words runs
     * outside any step.
     */
    @Test
    fun theThreadFoldsIntoSteps() {
        val folded = stepsOf(rows())
        val steps = folded.count { it is Step }
        assertTrue("expected the thread to fold into steps, got $steps", steps >= 20)
    }
}
''' % seq

open(r"D:/Documents/Claude Code/MCode/android/app/src/test/java/com/mcode/remote/StepFoldRealThreadTest.kt", "w", encoding="utf-8").write(test)
print("wrote real-thread test, %d parts" % len(seq))
