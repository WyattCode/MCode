import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''        modifier = Modifier
            .size(64.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable { open = true },'''

new = '''        /*
         * 84dp, not 64: Claude's own thumbnail is about 235px wide on the pad,
         * which is 84dp at 400dpi, with the same 12dp corners. A 64dp square
         * read as an icon rather than as the picture that was sent.
         */
        modifier = Modifier
            .size(84.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable { open = true },'''

assert old in s, "ImageBox size not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("thumbnail enlarged")