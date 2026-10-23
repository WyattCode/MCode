import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''fun stepsOf(rows: List<Any>): List<Any> {
    val out = mutableListOf<Any>()
    var i = 0
    while (i < rows.size) {
        val row = rows[i]
        val isAssistantProse = row is Item.Msg && row.role != "user"
        if (!isAssistantProse) {
            out.add(row)
            i++
            continue
        }
        val calls = mutableListOf<Any>()
        var j = i + 1
        while (j < rows.size && (rows[j] is Item.Tool || rows[j] is ToolRun)) {
            calls.add(rows[j])
            j++
        }
        out.add(if (calls.isEmpty()) row else Step(row, calls, "step.${(row as Item.Msg).id}"))
        i = j
    }
    return out
}'''

new = '''fun stepsOf(rows: List<Any>): List<Any> {
    fun isCall(r: Any) = r is Item.Tool || r is ToolRun
    val out = mutableListOf<Any>()
    var i = 0
    while (i < rows.size) {
        val row = rows[i]
        /*
         * A step is a call and the assistant words it belongs to - on either
         * side. The server orders these differently turn to turn: sometimes the
         * prose comes first and the calls follow, sometimes the calls are
         * flushed ahead of the text that describes them. Only looking forward
         * left half the steps unwrapped.
         */
        if (isCall(row) && out.isNotEmpty()) {
            val last = out.last()
            // Fold the call into the prose just before it, when there is one and
            // it is not already inside a step.
            if (last is Item.Msg && last.role != "user") {
                out[out.size - 1] = Step(last, mutableListOf<Any>(row), "step.${last.id}")
                i++
                continue
            }
            if (last is Step) {
                (last.calls as MutableList<Any>).add(row)
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
}'''

assert old in s, "stepsOf not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("steps fold both directions")