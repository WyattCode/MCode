import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old_start = '''fun stepsOf(rows: List<Any>): List<Any> {'''
i = s.index(old_start)
# find the end of the function: the line "}" at column 0 after the return
end_marker = "\n}\n\n/** Claude's summary of a run"
j = s.index(end_marker, i) + len("\n}\n")

new = '''fun stepsOf(rows: List<Any>): List<Any> {
    fun isCall(r: Any) = r is Item.Tool || r is ToolRun

    /*
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
}

'''

s = s[:i] + new + s[j:]
io.open(path, "w", encoding="utf-8").write(s)
print("stepsOf rewritten")