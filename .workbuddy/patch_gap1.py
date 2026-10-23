import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) Msg carries its creation time.
old = '''    data class Msg(val id: String, val role: String, var text: String, val images: List<String> = emptyList()) : Item() { override val key = "msg.$id" }'''
new = '''    data class Msg(val id: String, val role: String, var text: String, val images: List<String> = emptyList(), val at: Long = 0L) : Item() { override val key = "msg.$id" }'''
assert old in s
s = s.replace(old, new, 1)

# 2) A divider item.
old = '''    data class Msg(val id: String, val role: String, var text: String, val images: List<String> = emptyList(), val at: Long = 0L) : Item() { override val key = "msg.$id" }'''
new = '''    data class Msg(val id: String, val role: String, var text: String, val images: List<String> = emptyList(), val at: Long = 0L) : Item() { override val key = "msg.$id" }

    /**
     * Claude's wave divider: a wavy rule across the pane with the clock in the
     * middle, marking where a later stretch of the conversation begins. It is
     * inserted between turns that are more than five minutes apart, which is
     * the gap at which the transcript stops reading as one sitting.
     */
    data class Gap(val id: String, val label: String) : Item() { override val key = "gap.$id" }'''
assert old in s
s = s.replace(old, new, 1)

io.open(path, "w", encoding="utf-8").write(s)
print("Msg.at + Gap item added")