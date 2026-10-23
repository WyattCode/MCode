import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

replacements = [
    (
        '''    data class Msg(val id: String, val role: String, var text: String, val images: List<String> = emptyList(), val at: Long = 0L) : Item() { override val key = "msg.$id" }''',
        '''    data class Msg(val id: String, val role: String, var text: String, val images: List<String> = emptyList(), val at: Long = 0L, val steered: Boolean = false) : Item() { override val key = "msg.$id" }''',
    ),
    (
        '''                items[known] = existing.copy(text = next, images = images)''',
        '''                items[known] = existing.copy(text = next, images = images, steered = message.optBoolean("steered"))''',
    ),
    (
        '''                items.add(Item.Msg(id, role, body.ifEmpty { if (images.isEmpty()) "\u2026" else "" }, images, at))''',
        '''                items.add(Item.Msg(id, role, body.ifEmpty { if (images.isEmpty()) "\u2026" else "" }, images, at, message.optBoolean("steered")))''',
    ),
]

for old, new in replacements:
    assert old in s, old[:60]
    s = s.replace(old, new, 1)

io.open(path, "w", encoding="utf-8").write(s)
print("steered flag carried")