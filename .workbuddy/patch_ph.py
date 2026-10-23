import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                    placeholder = {
                        Text(
                            if (running) "\u5c06\u6d88\u606f\u52a0\u5165\u961f\u5217\u2026" else "\u4e0e MCode \u5bf9\u8bdd\u2026",
                            color = LocalMuted.current,
                        )
                    },'''

new = '''                    /*
                     * Claude's idle line reads 「\u8f93\u5165 / \u4ee5\u4f7f\u7528\u547d\u4ee4」 - it teaches the
                     * slash commands right where they would be typed - and
                     * its own grey is 123,121,116, a step lighter than the
                     * muted used for labels elsewhere on the page.
                     */
                    placeholder = {
                        Text(
                            if (running) "\u5c06\u6d88\u606f\u52a0\u5165\u961f\u5217\u2026" else "\u8f93\u5165 / \u4ee5\u4f7f\u7528\u547d\u4ee4",
                            color = if (LocalBg.current == DarkBg) DarkMuted else Color(0xFF7B7974),
                        )
                    },'''

assert old in s, "placeholder block not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("placeholder aligned")