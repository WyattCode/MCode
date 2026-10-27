import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                filePreview?.let { (name, body) ->
                    Spacer(Modifier.height(10.dp))'''
new = '''                val shown = filePreview
                if (shown != null) {
                    val (name, body) = shown
                    Spacer(Modifier.height(10.dp))'''

assert old in s, "preview block not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("preview destructured locally")
print("tail:", s[s.index('val shown = filePreview'):][:600])