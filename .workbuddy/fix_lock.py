import io

p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(p, encoding="utf-8").read()

old = """            Row(verticalAlignment = Alignment.CenterVertically) {
                Canvas(Modifier.size(11.2.dp)) {
                    val ink = LocalMuted"""

new = """            Row(verticalAlignment = Alignment.CenterVertically) {
                /*
                 * The padlock is drawn from a colour read outside the draw scope:
                 * a Canvas lambda is not composable, so `LocalMuted.current`
                 * cannot be called inside it.
                 */
                val lockInk = LocalMuted.current
                Canvas(Modifier.size(11.2.dp)) {
                    val ink = lockInk"""

assert old in s, "lock canvas"
s = s.replace(old, new, 1)

io.open(p, "w", encoding="utf-8").write(s)
print("lock colour hoisted out of the draw scope")
