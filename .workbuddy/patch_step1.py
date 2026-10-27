import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''fun rowsOf(items: List<Item>): List<Any> {
    val out = mutableListOf<Any>()
    var run = mutableListOf<Item.Tool>()
    fun flush() {
        if (run.isEmpty()) return
        out.add(if (run.size == 1) run.first() else ToolRun(run.toList(), "run.${run.first().uid}"))
        run = mutableListOf()
    }
    for (item in items) {
        if (item is Item.Tool) run.add(item)
        else {
            flush()
            out.add(item)
        }
    }
    flush()
    return out
}'''

new = '''fun rowsOf(items: List<Item>): List<Any> {
    val out = mutableListOf<Any>()
    var run = mutableListOf<Item.Tool>()
    fun flush() {
        if (run.isEmpty()) return
        out.add(if (run.size == 1) run.first() else ToolRun(run.toList(), "run.${run.first().uid}"))
        run = mutableListOf()
    }
    for (item in items) {
        if (item is Item.Tool) run.add(item)
        else {
            flush()
            out.add(item)
        }
    }
    flush()
    return out
}

/**
 * One step of a turn: the assistant's words and the calls it made right after.
 *
 * Claude threads a rounded rule down the left of that pair - 3.6dp wide,
 * 216,216,214, capped at both ends - so a paragraph and the tool rows under it
 * read as one move rather than as loose lines. Nothing in the phone's flat list
 * said those rows belonged to the words above them.
 *
 * User turns are never wrapped: their bubble is already a block of its own.
 */
data class Step(val body: Any?, val calls: List<Any>, val key: String)

/** Folds the flat rows into steps: prose plus the tool rows that follow it. */
fun stepsOf(rows: List<Any>): List<Any> {
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

assert old in s, "rowsOf not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("Step model added")