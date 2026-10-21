package com.mcode.remote

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/* ------------------------------------------------------------------ */
/* Markdown, the part of a reply that decides whether it can be read  */
/* ------------------------------------------------------------------ */

/**
 * The blocks a reply is made of.
 *
 * The phone used to print a reply's source: `# 版本信息` arrived with its hash
 * marks, a fenced block arrived as a wall of backticks. Claude's phone app sets
 * a reply the way the desktop does - headings that look like headings, code in
 * a box you can copy, lists with real bullets - so this is that: a small parser
 * for the subset a model actually writes, and composables for each block.
 */
sealed class MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock()
    data class Para(val text: String) : MdBlock()
    data class Code(val lang: String, val code: String) : MdBlock()
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<MdItem>) : MdBlock()
    data class Quote(val blocks: List<MdBlock>) : MdBlock()
    data class Table(val head: List<String>, val rows: List<List<String>>, val align: List<Int>) : MdBlock()
    data object Rule : MdBlock()
}

/** One list entry, with its nesting depth and its task box if it has one. */
data class MdItem(val text: String, val depth: Int, val task: Boolean = false, val checked: Boolean = false)

private val FENCE = Regex("^\\s{0,3}(`{3,}|~{3,})\\s*([^`\\s]*)")
private val HEADING = Regex("^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$")
private val RULE = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
private val BULLET = Regex("^(\\s*)([-*+])\\s+(.*)$")
private val NUMBERED = Regex("^(\\s*)(\\d{1,9})[.)]\\s+(.*)$")
private val QUOTE = Regex("^\\s{0,3}>\\s?(.*)$")
private val DELIMITER = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")
private val TASK = Regex("^\\[([ xX])]\\s+(.*)$")

object Md {
    /** Splits a reply into blocks. Anything it cannot place becomes a paragraph. */
    fun blocks(source: String): List<MdBlock> {
        val lines = source.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        return parse(lines, 0, lines.size)
    }

    private fun parse(lines: List<String>, from: Int, to: Int): List<MdBlock> {
        val out = mutableListOf<MdBlock>()
        var i = from
        while (i < to) {
            val line = lines[i]
            if (line.isBlank()) { i++; continue }

            val fence = FENCE.find(line)
            if (fence != null) {
                val mark = fence.groupValues[1]
                val lang = fence.groupValues[2].lowercase()
                val body = StringBuilder()
                i++
                while (i < to) {
                    val close = FENCE.find(lines[i])
                    // A fence closes on the same character, at least as long.
                    if (close != null && close.groupValues[1][0] == mark[0] && close.groupValues[1].length >= mark.length && lines[i].trim().length == close.groupValues[1].length) { i++; break }
                    body.append(lines[i]).append('\n')
                    i++
                }
                out.add(MdBlock.Code(lang, body.toString().trimEnd('\n')))
                continue
            }

            val heading = HEADING.find(line)
            if (heading != null) {
                out.add(MdBlock.Heading(heading.groupValues[1].length, heading.groupValues[2]))
                i++
                continue
            }

            if (RULE.matches(line)) { out.add(MdBlock.Rule); i++; continue }

            // A table needs its delimiter row to be one: otherwise the pipes are prose.
            if (line.contains('|') && i + 1 < to && DELIMITER.matches(lines[i + 1])) {
                val head = cells(line)
                val align = cells(lines[i + 1]).map {
                    when {
                        it.startsWith(":") && it.endsWith(":") -> 1
                        it.endsWith(":") -> 2
                        else -> 0
                    }
                }
                val rows = mutableListOf<List<String>>()
                i += 2
                while (i < to && lines[i].contains('|') && lines[i].isNotBlank()) { rows.add(cells(lines[i])); i++ }
                out.add(MdBlock.Table(head, rows, align))
                continue
            }

            if (QUOTE.matches(line)) {
                val inner = mutableListOf<String>()
                while (i < to) {
                    val m = QUOTE.find(lines[i]) ?: break
                    inner.add(m.groupValues[1])
                    i++
                }
                out.add(MdBlock.Quote(parse(inner, 0, inner.size)))
                continue
            }

            val bullet = BULLET.find(line)
            val numbered = NUMBERED.find(line)
            if (bullet != null || numbered != null) {
                val ordered = bullet == null
                val start = if (numbered != null) numbered.groupValues[2].toIntOrNull() ?: 1 else 1
                val items = mutableListOf<MdItem>()
                while (i < to) {
                    val current = lines[i]
                    val b = BULLET.find(current)
                    val n = NUMBERED.find(current)
                    // A run of bullets and a run of numbers are two lists even
                    // when no blank line separates them: `1.` after a `-` starts
                    // an ordered list, it does not join the bulleted one.
                    val match = if (ordered) n else b
                    if (match == null) break
                    val indent = match.groupValues[1].replace("\t", "  ").length
                    var text = match.groupValues[3]
                    val task = TASK.find(text)
                    val depth = (indent / 2).coerceIn(0, 4)
                    if (task != null) {
                        items.add(MdItem(task.groupValues[2], depth, true, task.groupValues[1].lowercase() == "x"))
                    } else {
                        items.add(MdItem(text, depth))
                    }
                    i++
                }
                out.add(MdBlock.ListBlock(ordered, start, items))
                continue
            }

            // Everything else, up to the next blank line or the start of a block.
            val para = StringBuilder()
            while (i < to) {
                val current = lines[i]
                if (current.isBlank()) break
                if (para.isNotEmpty() && (FENCE.find(current) != null || HEADING.find(current) != null || RULE.matches(current) || BULLET.find(current) != null || NUMBERED.find(current) != null || QUOTE.matches(current))) break
                if (para.isNotEmpty()) para.append('\n')
                para.append(current.trim())
                i++
            }
            out.add(MdBlock.Para(para.toString()))
        }
        return out
    }

    private fun cells(row: String): List<String> =
        row.trim().trim('|').split('|').map { it.trim() }
}

/* ------------------------------------------------------------------ */
/* Inline spans                                                        */
/* ------------------------------------------------------------------ */

/** An inline run of text plus the ranges that should open something. */
data class MdInline(val text: AnnotatedString, val links: List<Pair<IntRange, String>>)

object MdText {
    private val CODE = Regex("`([^`]+)`")
    private val EMPHASIS = Regex("\\*\\*(.+?)\\*\\*|__(.+?)__|~~(.+?)~~|\\*(?!\\s)(.+?)(?<!\\s)\\*|_(?!\\s)(.+?)(?<!\\s)_|\\[([^\\]]+)]\\((\\S+?)\\)|(https?://[^\\s)<]+)")

    fun inline(source: String, linkColor: Color): MdInline {
        val builder = AnnotatedString.Builder()
        val links = mutableListOf<Pair<IntRange, String>>()
        var at = 0
        // Code wins over emphasis, the way the spec says it does: split the
        // line on code first, then read the gaps for everything else.
        for (hit in CODE.findAll(source)) {
            if (hit.range.first > at) emphasis(builder, source.substring(at, hit.range.first), links, linkColor)
            builder.pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = chipBg, color = chipFg, fontSize = 13.sp))
            builder.append(hit.groupValues[1])
            builder.pop()
            at = hit.range.last + 1
        }
        if (at < source.length) emphasis(builder, source.substring(at), links, linkColor)
        return MdInline(builder.toAnnotatedString(), links)
    }

    private fun emphasis(builder: AnnotatedString.Builder, source: String, links: MutableList<Pair<IntRange, String>>, linkColor: Color) {
        var at = 0
        for (hit in EMPHASIS.findAll(source)) {
            builder.append(source.substring(at, hit.range.first))
            val g = hit.groupValues
            when {
                g[1].isNotEmpty() || g[2].isNotEmpty() -> {
                    builder.pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                    builder.append(g[1].ifEmpty { g[2] })
                    builder.pop()
                }
                g[3].isNotEmpty() -> {
                    builder.pushStyle(SpanStyle(textDecoration = TextDecoration.LineThrough))
                    builder.append(g[3])
                    builder.pop()
                }
                g[4].isNotEmpty() || g[5].isNotEmpty() -> {
                    builder.pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                    builder.append(g[4].ifEmpty { g[5] })
                    builder.pop()
                }
                g[6].isNotEmpty() -> {
                    val label = g[6]
                    val url = g[7]
                    val start = builder.length
                    builder.pushStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
                    builder.append(label)
                    builder.pop()
                    links.add((start until builder.length) to url)
                }
                g[8].isNotEmpty() -> {
                    val url = g[8]
                    val start = builder.length
                    builder.pushStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
                    builder.append(url)
                    builder.pop()
                    links.add((start until builder.length) to url)
                }
            }
            at = hit.range.last + 1
        }
        builder.append(source.substring(at))
    }
}

/*
 * The two chip colours, set on the same values the desktop uses: a reply's
 * inline code is #3a3a38 on #f0f0f2 in light and #e6e6e6 on #2e2e2e in dark.
 * They are module state rather than composition locals because the parser runs
 * outside composition; each render sets them first.
 */
private var chipBg = Color(0xFFF0F0F2)
private var chipFg = Color(0xFF3A3A38)
private val LinkBlue = Color(0xFF2F6FED)

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * A reply, set the way the desktop sets one.
 *
 * Sizes are the desktop's own scale, which the phone already ships at: prose
 * 15 on a 23 line, headings 20 / 20 / 16 / 16 / 14 / 14, a 14 step below a
 * paragraph, code a step smaller than prose.
 */
/*
 * 10px between paragraphs on the reference - 3.2dp - where this used 14. Two
 * sentences of the same paragraph sat 40dp apart in the phone's transcript and
 * 3 in Claude's, which made every reply look loosely set.
 */
private val PARAGRAPH_GAP = 3.2.dp

@Composable
fun MarkdownBody(source: String, modifier: Modifier = Modifier, dark: Boolean = false, onCopy: (String) -> Unit = {}) {
    val blocks = remember(source) { Md.blocks(source) }
    val textColor = LocalText.current
    val muted = LocalMuted.current
    chipBg = if (dark) Color(0xFF2E2E2E) else Color(0xFFF0F0F2)
    chipFg = if (dark) Color(0xFFE6E6E6) else Color(0xFF3A3A38)
    Column(modifier) {
        blocks.forEachIndexed { index, block ->
            val last = index == blocks.lastIndex
            when (block) {
                is MdBlock.Heading -> {
                    val size = when (block.level) { 1, 2 -> 24.sp; 3, 4 -> 19.sp; else -> 17.sp }
                    val top = when (block.level) { 1 -> 0.dp; 2 -> 18.dp; 3, 4 -> 16.dp; else -> 12.dp }
                    MdLine(
                        block.text, size = size, weight = FontWeight.SemiBold, color = textColor,
                        modifier = Modifier.padding(top = if (index == 0) 0.dp else top, bottom = 8.dp),
                        lineHeight = (size.value * 1.4f).sp,
                    )
                }
                is MdBlock.Para -> MdLine(
                    block.text, color = textColor,
                    modifier = Modifier.padding(bottom = if (last) 0.dp else PARAGRAPH_GAP),
                )
                is MdBlock.Code -> CodeBox(block.lang, block.code, dark, Modifier.padding(vertical = 4.dp))
                is MdBlock.ListBlock -> ListBox(block, textColor, modifier = Modifier.padding(bottom = if (last) 0.dp else PARAGRAPH_GAP))
                is MdBlock.Quote -> Row(
                    Modifier
                        .padding(bottom = if (last) 0.dp else 14.dp)
                        .height(IntrinsicSize.Min),
                ) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(LocalLine.current))
                    // A quote keeps its own paragraphs, so it recurses with a
                    // step in from the rule rather than flattening to one line.
                    Column(Modifier.padding(start = 12.dp)) {
                        block.blocks.forEach { inner ->
                            when (inner) {
                                is MdBlock.Para -> MdLine(inner.text, color = muted, modifier = Modifier.padding(bottom = 6.dp))
                                is MdBlock.Code -> CodeBox(inner.lang, inner.code, dark)
                                is MdBlock.ListBlock -> ListBox(inner, muted)
                                is MdBlock.Heading -> MdLine(inner.text, weight = FontWeight.SemiBold, color = muted)
                                else -> Unit
                            }
                        }
                    }
                }
                is MdBlock.Table -> TableBox(block, textColor, muted, Modifier.padding(bottom = if (last) 0.dp else 14.dp))
                MdBlock.Rule -> Box(Modifier.fillMaxWidth().padding(vertical = 16.dp).height(1.dp).background(LocalLine.current))
            }
        }
    }
}

/**
 * One inline line.
 *
 * Links are handled by hand: the text keeps its own ranges, and a tap is
 * turned into an offset in the laid-out line, so the right URL opens.
 */
/*
 * Find-in-view's needle, as a composition local.
 *
 * The desktop paints its matches with the browser's Custom Highlight API, so
 * every text node under the pane is covered without any one component knowing
 * about the search. Compose has no such registry; a local is the nearest thing
 * - a `Text` looks the needle up, paints the spans itself, and no call site has
 * to pass anything down. `null` means "no search open", which is the state on
 * every ordinary render.
 */
data class FindNeedle(val query: String, val active: Int)

val LocalFind = androidx.compose.runtime.compositionLocalOf<FindNeedle?> { null }

/**
 * The needle's spans, as the desktop's browser highlight paints them: every
 * match tinted, the one being looked at picked out more strongly. Only a
 * background is added, so a link's colour and a heading's weight survive.
 */
fun findSpans(source: String, query: String, active: Int): androidx.compose.ui.text.AnnotatedString {
    val out = androidx.compose.ui.text.AnnotatedString.Builder(source)
    if (query.isBlank()) return out.toAnnotatedString()
    var at = 0
    var hit = 0
    while (true) {
        val found = source.indexOf(query, at, ignoreCase = true)
        if (found < 0) break
        out.addStyle(
            androidx.compose.ui.text.SpanStyle(
                background = if (hit == active) Color(0xFFF6C77A) else Color(0x59F6C77A),
            ),
            found,
            found + query.length,
        )
        at = found + query.length
        hit++
    }
    return out.toAnnotatedString()
}

@Composable
private fun MdLine(
    source: String,
    color: Color,
    modifier: Modifier = Modifier,
    /*
     * Measured off Claude's own transcript on this pad: a line of body text is
     * 64px tall, which is 20.3dp - 15sp on a 20sp line, not the 17/26 this
     * carried. The over-size face and its 26 line were the largest single
     * difference in the transcript: a paragraph of the same words was a third
     * taller here than in the reference.
     */
    size: androidx.compose.ui.unit.TextUnit = 15.sp,
    weight: FontWeight? = null,
    lineHeight: androidx.compose.ui.unit.TextUnit = 20.sp,
) {
    val context = LocalContext.current
    val inline = remember(source, color) { MdText.inline(source, LinkBlue) }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val needle = LocalFind.current
    /*
     * The needle's tint goes on after the line's own spans (a bold heading, a
     * link's colour) so a match inside one is still visible: the highlight is a
     * background, and only `color` would be fought over.
     */
    val annotated = remember(inline, weight, needle?.query, needle?.active) {
        val plain = if (weight == null) inline.text else buildAnnotatedString {
            append(inline.text)
            addStyle(SpanStyle(fontWeight = weight), 0, inline.text.length)
        }
        if (needle == null || needle.query.isBlank()) plain
        else buildAnnotatedString {
            append(plain)
            for (span in findSpans(inline.text.toString(), needle.query, needle.active).spanStyles) {
                addStyle(span.item, span.start, span.end)
            }
        }
    }
    Text(
        annotated,
        fontSize = size,
        lineHeight = lineHeight,
        color = color,
        onTextLayout = { layout = it },
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (inline.links.isEmpty()) Modifier else Modifier.pointerInput(inline) {
                    detectTapGestures { pos ->
                        val index = layout?.getOffsetForPosition(pos) ?: return@detectTapGestures
                        val hit = inline.links.firstOrNull { index in it.first }
                        if (hit != null) runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(hit.second)))
                        }
                    }
                },
            ),
    )
}

/** A fenced block: language at the start of its head, a copy button at the end. */
@Composable
private fun CodeBox(lang: String, code: String, dark: Boolean, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(code) { mutableStateOf(false) }
    val fill = if (dark) Color(0xFF2E2E2E) else Color(0xFFFFFFFF)
    val line = if (dark) Color(0xFF2E2E2E) else Color(0xFFF0EBE5)
    val head = if (dark) Color(0xFFB8B8B8) else Color(0x99151C13)
    Column(
        modifier
            .fillMaxWidth()
            .background(fill, RoundedCornerShape(8.dp)),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                lang.ifEmpty { "code" },
                fontSize = 12.sp,
                color = head,
                modifier = Modifier.weight(1f),
            )
            Row(
                Modifier
                    .clickable {
                        clipboard.setText(AnnotatedString(code))
                        copied = true
                    }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy,
                    contentDescription = if (copied) "已复制" else "复制",
                    tint = if (copied) Color(0xFF00C950) else head,
                    modifier = Modifier.size(13.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(if (copied) "已复制" else "复制", fontSize = 12.sp, color = head)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(line))
        /*
         * A long line wraps instead of scrolling sideways.
         *
         * Sideways scrolling in a phone transcript is a poor affordance: the
         * swipe has to start inside one card, fights the vertical scroll of the
         * thread, and gives no sign that it is even possible - the line simply
         * ended and read as cut off. Claude wraps a long line inside the card,
         * keeping its indent so it still reads as code.
         */
        Text(
            code,
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            lineHeight = 22.sp,
            color = LocalText.current,
            softWrap = true,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun ListBox(block: MdBlock.ListBlock, color: Color, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        var number = block.start
        for (item in block.items) {
            val marker = when {
                item.task -> if (item.checked) "✓" else "○"
                block.ordered -> "${number++}."
                else -> "•"
            }
            Row(Modifier.fillMaxWidth().padding(start = (item.depth * 16).dp, bottom = 6.dp)) {
                Text(
                    marker,
                    /*
                     * 18sp/27sp, measured off Claude's own reply on this pad:
                     * one CJK glyph's ink is 36px and its line pitch is 107px,
                     * which is 18sp at 400dpi with 1.5 leading. The 15sp/19sp
                     * this used to be made a glyph 29px and set the paragraph a
                     * fifth shorter and far tighter than the original.
                     */
                    fontSize = 17.sp,
                    lineHeight = 26.sp,
                    color = if (item.task && !item.checked) LocalMuted.current else color,
                    modifier = Modifier.width(if (block.ordered) 24.dp else 16.dp),
                )
                MdLine(item.text, color = color, modifier = Modifier.weight(1f))
            }
        }
    }
}

/**
 * A table scrolls sideways inside the reply rather than widening the column.
 *
 * A column is as wide as its widest cell. The width is counted in characters
 * rather than measured: measuring inside `remember` can come back empty before
 * the font resolver is ready, which collapsed every column to a single glyph
 * and stacked `列A` on two lines. A CJK glyph is two Latin characters wide, so
 * it counts as two - that is the whole difference that made the first attempt
 * wrong.
 */
@Composable
private fun TableBox(block: MdBlock.Table, color: Color, muted: Color, modifier: Modifier = Modifier) {
    val columns = maxOf(block.head.size, block.rows.maxOfOrNull { it.size } ?: 0)
    val widths = remember(block) {
        List(columns) { index ->
            val widest = maxOf(
                cellUnits(block.head.getOrNull(index) ?: ""),
                block.rows.maxOfOrNull { cellUnits(it.getOrNull(index) ?: "") } ?: 0,
            )
            // 8.2dp per Latin character at 13.5sp, with 12dp of padding a side. The
            // estimate leans wide on purpose: a column one glyph short wraps a
            // word, and a column slightly too wide only looks airy.
            (widest.coerceIn(4, 48) * 8.2f + 24f).dp
        }
    }
    Column(modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Row(Modifier.background(LocalPill.current.copy(alpha = 0.5f))) {
            for (index in 0 until columns) {
                Text(
                    block.head.getOrNull(index) ?: "",
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = color,
                    modifier = Modifier.width(widths[index]).padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }
        }
        block.rows.forEach { row ->
            Row {
                for (index in 0 until columns) {
                    Text(
                        row.getOrNull(index) ?: "",
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                        color = color,
                        modifier = Modifier.width(widths[index]).padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(LocalLine.current.copy(alpha = 0.6f)))
        }
    }
}

/** How many Latin character widths a cell takes: a CJK glyph counts as two. */
private fun cellUnits(text: String): Int {
    var units = 0
    for (ch in text) {
        units += when {
            ch.code in 0x1100..0x115F || ch.code in 0x2E80..0xA4CF || ch.code in 0xAC00..0xD7A3 ||
                ch.code in 0xF900..0xFAFF || ch.code in 0xFE30..0xFE6F || ch.code in 0xFF00..0xFF60 ||
                ch.code in 0xFFE0..0xFFE6 || ch.code in 0x1F300..0x1F9FF -> 2
            else -> 1
        }
    }
    return units
}