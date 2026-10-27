import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''        } else {
            val body = text.toString().trim()
            if (body.isNotEmpty() || role == "user" || images.isNotEmpty()) {
                items.add(Item.Msg(id, role, body.ifEmpty { if (images.isEmpty()) "…" else "" }, images))
                messageIndex[id] = items.size - 1
            }
        }'''

new = '''        } else {
            val body = text.toString().trim()
            if (body.isNotEmpty() || role == "user" || images.isNotEmpty()) {
                /*
                 * A later sitting gets the wave divider: Claude puts one where
                 * the conversation resumes after a gap, with the clock in the
                 * middle. Five minutes is where a transcript stops reading as
                 * one stretch; a shorter pause needs no mark.
                 */
                val at = message.optJSONObject("time")?.optLong("created", 0L) ?: 0L
                if (role == "user" && at > 0L) {
                    val previous = items.lastOrNull { it is Item.Msg } as? Item.Msg
                    if (previous != null && previous.at > 0L && at - previous.at > 5 * 60_000L) {
                        val label = android.text.format.DateFormat.format("HH:mm", at).toString()
                        items.add(Item.Gap("gap.${previous.id}.$id", label))
                    }
                }
                items.add(Item.Msg(id, role, body.ifEmpty { if (images.isEmpty()) "…" else "" }, images, at))
                messageIndex[id] = items.size - 1
            }
        }'''

assert old in s
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("gap divider inserted on a long pause")