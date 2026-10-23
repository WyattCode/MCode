import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Render the item in the timeline's when().
old = '''                    is Item.Err -> {'''
new = '''                    is Item.Gap -> GapRule(item.label)
                    is Item.Err -> {'''
assert old in s
s = s.replace(old, new, 1)

# And the composable itself, next to the working line.
old2 = '''@Composable
fun WorkingLine() {'''
new2 = '''/**
 * The wave rule Claude draws between sittings.
 *
 * Measured off its own divider on the pad: 9px tall at 400dpi (about 3dp), a
 * 183,183,181 hairline that undulates across the pane, broken in the middle for
 * the clock. A straight rule would read as a section break in a document; the
 * wave is what makes it read as time passing.
 */
@Composable
fun GapRule(label: String) {
    val ink = if (LocalBg.current == DarkBg) Color(0xFF4A4A48) else Color(0xFFB7B7B5)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Canvas(Modifier.weight(1f).height(9.dp)) {
            val amp = size.height / 3f
            val mid = size.height / 2f
            val step = 9.dp.toPx()
            val path = androidx.compose.ui.graphics.Path()
            path.moveTo(0f, mid)
            var x = 0f
            var up = true
            while (x < size.width) {
                val nx = (x + step).coerceAtMost(size.width)
                // Quadratic humps, the same shape as a tilde repeated.
                path.quadraticTo((x + nx) / 2f, if (up) mid - amp * 2f else mid + amp * 2f, nx, mid)
                up = !up
                x = nx
            }
            drawPath(path, ink, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.5f))
        }
        Text(
            label,
            fontSize = 11.sp,
            color = LocalMuted.current,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        Canvas(Modifier.weight(1f).height(9.dp)) {
            val amp = size.height / 3f
            val mid = size.height / 2f
            val step = 9.dp.toPx()
            val path = androidx.compose.ui.graphics.Path()
            path.moveTo(0f, mid)
            var x = 0f
            var up = true
            while (x < size.width) {
                val nx = (x + step).coerceAtMost(size.width)
                path.quadraticTo((x + nx) / 2f, if (up) mid - amp * 2f else mid + amp * 2f, nx, mid)
                up = !up
                x = nx
            }
            drawPath(path, ink, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.5f))
        }
    }
}

@Composable
fun WorkingLine() {'''
assert old2 in s
s = s.replace(old2, new2, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("GapRule added")