import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old_wave = '''        Canvas(Modifier.weight(1f).height(9.dp)) {
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
        }'''

old_wave2 = '''        Canvas(Modifier.weight(1f).height(9.dp)) {
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
        }'''

# Replace both Canvases with a helper function call.
s = s.replace(old_wave, '''        WaveLine(ink, Modifier.weight(1f))''', 1)
s = s.replace(old_wave2, '''        WaveLine(ink, Modifier.weight(1f))''', 1)

helper = '''/** One wavy rule: quadratic humps at the pitch measured off Claude's divider. */
@Composable
private fun WaveLine(ink: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.height(9.dp)) {
        val amp = size.height / 3f
        val mid = size.height / 2f
        val step = with(density) { 9.dp.toPx() }
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

'''
s = s.replace('''@Composable
fun GapRule(label: String) {''', helper + '''@Composable
fun GapRule(label: String) {''', 1)

io.open(path, "w", encoding="utf-8").write(s)
print("WaveLine extracted")