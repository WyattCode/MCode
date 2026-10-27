import io

path = "android/app/src/main/java/com/mcode/remote/Markdown.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                    fontSize = 15.sp,
                    lineHeight = 23.sp,'''
new = '''                    fontSize = 15.sp,
                    // 19sp, not 23: Claude's prose measures 53px per line on
                    // the pad (19sp at 400dpi), and the extra leading here made
                    // the same paragraph a third taller and the thread longer
                    // to read than the original.
                    lineHeight = 19.sp,'''

assert old in s, "paragraph style not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("prose leading aligned")