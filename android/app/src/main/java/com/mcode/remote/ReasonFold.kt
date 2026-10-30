package com.mcode.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The thinking behind a reply, folded away by default.
 *
 * The cockpit draws the same thing as a native `<details class="reasonfold">`
 * with a 「思考过程」 summary; this is that fold in Compose. It is deliberately
 * secondary - muted ink, a thin rule down the left, small type - so it never
 * competes with the answer it sits above.
 *
 * Collapsed until tapped, and drawn only when there is something to show: a
 * blank fold would put an empty box under every turn that never thought.
 */
@Composable
fun ReasonFold(text: String, modifier: Modifier = Modifier) {
    if (text.isBlank()) return
    var open by remember { mutableStateOf(false) }
    val muted = LocalMuted.current
    val line = LocalLine.current
    Column(
        modifier
            .fillMaxWidth()
            .drawBehind {
                // The cockpit's `.reasonfold` left rule: 2dp of `--line`.
                drawRect(
                    color = line,
                    topLeft = Offset.Zero,
                    size = Size(2.dp.toPx(), size.height),
                )
            }
            .padding(start = 10.dp, top = 4.dp, end = 4.dp, bottom = 4.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { open = !open }
                .padding(vertical = 4.dp),
        ) {
            BasicText(
                text = if (open) "▾ 思考过程" else "▸ 思考过程",
                style = TextStyle(fontSize = 12.sp, color = muted),
            )
        }
        if (open) {
            BasicText(
                text = text,
                style = TextStyle(
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    color = muted,
                    fontFamily = FontFamily.Monospace,
                ),
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
