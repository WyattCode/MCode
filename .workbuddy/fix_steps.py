p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """    /*
     * A step is the assistant's words and the calls it made, whichever side of
     * the words they arrived on.
     *
     * The server's order varies: sometimes the calls are flushed first and the
     * prose that describes them follows, sometimes the reverse. Both belong to
     * one step, and Claude draws one rule beside the pair. Folding only forward
     * left most steps unwrapped; folding only backward left the others.
     */
    val out = mutableListOf<Any>()
    var i = 0
    while (i < rows.size) {
        val row = rows[i]
        if (isCall(row)) {
            // Calls belong to the nearest assistant prose in this stretch - the
            // paragraph they were made for, not to the user's prompt above them.
            val owner = out.indexOfLast { it is Item.Msg && it.role != "user" || it is Step }
            if (owner >= 0) {
                val existing = out[owner]
                if (existing is Step) {
                    existing.calls.add(row)
                } else if (existing is Item.Msg) {
                    out[owner] = Step(existing, mutableListOf<Any>(row), "step.${existing.id}")
                }
                i++
                continue
            }
        }
        val isAssistantProse = row is Item.Msg && row.role != "user"
        if (!isAssistantProse) {
            out.add(row)
            i++
            continue
        }
        val calls = mutableListOf<Any>()
        var j = i + 1
        while (j < rows.size && isCall(rows[j])) {
            calls.add(rows[j])
            j++
        }
        out.add(if (calls.isEmpty()) row else Step(row, calls, "step.${(row as Item.Msg).id}"))
        i = j
    }
    return out
}"""

new = """    /*
     * A step is the assistant's words and the calls it made, whichever side of
     * the words they arrived on.
     *
     * The server's order varies: sometimes the calls are flushed first and the
     * prose that describes them follows, sometimes the reverse. Both belong to
     * one step, and Claude draws one rule beside the pair.
     *
     * The backward half of that was not working. It looked for its owner among
     * the rows already emitted, which answers a question about the past - so a
     * call that came *before* its prose found nothing, was emitted bare, and the
     * prose then opened a step with no calls in it. Measured on a real thread:
     * 16 runs in it are tool-parts immediately followed by the assistant's text,
     * which is exactly the order the old code could not fold. So the prose now
     * adopts the contiguous calls sitting immediately above it, and only those:
     * the walk stops at anything that is not a call, which keeps it from
     * reaching across a user turn or another message's words.
     */
    val out = mutableListOf<Any>()
    var i = 0
    while (i < rows.size) {
        val row = rows[i]
        if (isCall(row)) {
            // Calls belong to the nearest assistant prose in this stretch - the
            // paragraph they were made for, not to the user's prompt above them.
            val owner = out.indexOfLast { (it is Item.Msg && it.role != "user") || it is Step }
            if (owner >= 0) {
                val existing = out[owner]
                if (existing is Step) {
                    existing.calls.add(row)
                    i++
                    continue
                } else if (existing is Item.Msg) {
                    out[owner] = Step(existing, mutableListOf<Any>(row), "step.${existing.id}")
                    i++
                    continue
                }
            }
            // No prose above it yet: fall through and emit it bare. The prose
            // that arrives next will pick it back up.
        }
        val isAssistantProse = row is Item.Msg && row.role != "user"
        if (!isAssistantProse) {
            out.add(row)
            i++
            continue
        }
        /*
         * The calls that came before these words.
         *
         * Taken from the tail of `out`, and only while they are still
         * unclaimed calls - a plain Item.Tool or a ToolRun that no step adopted.
         * Stopping at the first non-call is what makes this safe: a user turn or
         * an earlier step ends the run, so nothing is pulled across a boundary.
         */
        val before = mutableListOf<Any>()
        while (out.isNotEmpty() && isCall(out.last())) {
            before.add(0, out.removeAt(out.lastIndex))
        }
        val after = mutableListOf<Any>()
        var j = i + 1
        while (j < rows.size && isCall(rows[j])) {
            after.add(rows[j])
            j++
        }
        val calls = before + after
        out.add(if (calls.isEmpty()) row else Step(row, calls, "step.${(row as Item.Msg).id}"))
        i = j
    }
    return out
}"""

assert old in s, "stepsOf body"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("stepsOf: prose adopts the calls above it")
