import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                    is Step -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                        Box(
                            Modifier
                                .padding(end = 10.dp, top = 6.dp, bottom = 2.dp)
                                .fillMaxHeight()
                                .width(3.5.dp)'''

new = '''                    /*
                     * `IntrinsicSize.Min` is what lets the rule stretch: in a Row
                     * whose children size themselves, `fillMaxHeight` has no
                     * height to fill - the bar collapsed to nothing and the step
                     * looked exactly like a bare reply.
                     */
                    is Step -> Row(
                        Modifier.fillMaxWidth().height(IntrinsicSize.Min),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(
                            Modifier
                                .padding(end = 10.dp, top = 6.dp, bottom = 2.dp)
                                .fillMaxHeight()
                                .width(3.5.dp)'''

assert old in s, "step row not found"
s = s.replace(old, new, 1)

if "import androidx.compose.foundation.layout.IntrinsicSize" not in s:
    s = s.replace("import androidx.compose.foundation.layout.PaddingValues", "import androidx.compose.foundation.layout.IntrinsicSize\nimport androidx.compose.foundation.layout.PaddingValues", 1)
io.open(path, "w", encoding="utf-8").write(s)
print("intrinsic height set")