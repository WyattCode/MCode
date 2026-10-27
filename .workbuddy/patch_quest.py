import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

start = '''fun QuestCard(item: Item.Quest, onAnswer: (String, List<String>) -> Unit) {'''
end = '''@Composable
/**
 * What a permission request is asking to do, in MCode's own words.'''

i = s.index(start)
j = s.index(end, i)

new_block = '''fun QuestCard(item: Item.Quest, onAnswer: (String, List<String>) -> Unit) {
    val questions = item.request.optJSONArray("questions") ?: return
    /*
     * Every question, not just the first.
     *
     * The tool sends a list - a model may ask three things at once - and this
     * card rendered `questions[0]` and dropped the rest, so a request that
     * wanted two answers could only ever be given one. `multiple` was ignored
     * for the same reason: a checkbox question behaved like a radio one.
     *
     * Answers are collected per question and sent together when the last one
     * has an answer, which is what the protocol's one `reply` carries.
     */
    val picks = remember(item.requestId) { mutableStateMapOf<Int, List<String>>() }
    var custom by remember(item.requestId) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().background(LocalPill.current, RoundedCornerShape(12.dp)).padding(12.dp)) {
        for (qi in 0 until questions.length()) {
            val q = questions.optJSONObject(qi) ?: continue
            if (qi > 0) Spacer(Modifier.height(12.dp))
            Text(q.optString("header", "问题"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = LocalText.current)
            Spacer(Modifier.height(4.dp))
            Text(q.optString("question"), fontSize = 13.sp, color = LocalText.current)
            Spacer(Modifier.height(10.dp))
            val multiple = q.optBoolean("multiple")
            val chosen = picks[qi].orEmpty()
            val opts = q.optJSONArray("options")
            if (opts != null) for (i in 0 until opts.length()) {
                val o = opts.optJSONObject(i) ?: continue
                val label = o.optString("label")
                val on = label in chosen
                Surface(
                    Modifier
                        .fillMaxWidth()
                        .padding(bottom = 6.dp)
                        .clickable {
                            if (multiple) {
                                // A checkbox question accumulates; a radio one
                                // replaces, which is how the desktop reads them.
                                picks[qi] = if (on) chosen - label else chosen + label
                            } else {
                                picks[qi] = listOf(label)
                                if (questions.length() == 1) onAnswer(item.requestId, listOf(label))
                            }
                        },
                    shape = RoundedCornerShape(8.dp),
                    color = if (on) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.surfaceVariant,
                    border = if (on) androidx.compose.foundation.BorderStroke(1.dp, LocalText.current.copy(alpha = 0.35f)) else null,
                ) {
                    Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                        Text(label, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                        if (o.optString("description").isNotBlank()) {
                            Text(o.optString("description"), fontSize = 11.sp, color = LocalMuted.current)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                custom, { custom = it },
                Modifier.weight(1f),
                placeholder = { Text("自行输入…", fontSize = 12.sp, color = LocalMuted.current) },
                singleLine = true,
            )
            TextButton(
                {
                    // Custom words win when typed; otherwise the picks, gathered
                    // in question order.
                    val answer = if (custom.isNotBlank()) {
                        listOf(custom.trim())
                    } else {
                        (0 until questions.length()).flatMap { picks[it].orEmpty() }
                    }
                    if (answer.isNotEmpty()) onAnswer(item.requestId, answer)
                },
            ) { Text("发送") }
        }
    }
}

'''

s = s[:i] + new_block + s[j:]

if "import androidx.compose.runtime.mutableStateMapOf" not in s:
    s = s.replace("import androidx.compose.runtime.mutableStateListOf", "import androidx.compose.runtime.mutableStateListOf\nimport androidx.compose.runtime.mutableStateMapOf", 1)

io.open(path, "w", encoding="utf-8").write(s)
print("multi-question card")