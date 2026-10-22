package com.mcode.remote

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.ui.graphics.luminance
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.OpenInFull
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
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
data class MdInline(
    val text: AnnotatedString,
    val links: List<Pair<IntRange, String>>,
    /** Where the inline code sits, so the line can paint a rounded fill under it. */
    val code: List<IntRange> = emptyList(),
)

object MdText {
    private val CODE = Regex("`([^`]+)`")
    private val EMPHASIS = Regex("\\*\\*(.+?)\\*\\*|__(.+?)__|~~(.+?)~~|\\*(?!\\s)(.+?)(?<!\\s)\\*|_(?!\\s)(.+?)(?<!\\s)_|\\[([^\\]]+)]\\((\\S+?)\\)|(https?://[^\\s)<]+)")

    fun inline(source: String, linkColor: Color): MdInline {
        val builder = AnnotatedString.Builder()
        val links = mutableListOf<Pair<IntRange, String>>()
        val codeRanges = mutableListOf<IntRange>()
        var at = 0
        // Code wins over emphasis, the way the spec says it does: split the
        // line on code first, then read the gaps for everything else.
        for (hit in CODE.findAll(source)) {
            if (hit.range.first > at) emphasis(builder, source.substring(at, hit.range.first), links, linkColor)
            /*
             * The chip's own extent, kept so the line can round its ends.
             *
             * A `SpanStyle` background is a rectangle with square corners - the
             * rectangle is drawn behind the glyphs, and no amount of shape on
             * the `Text` reaches inside it. The reference's inline code is a
             * 29.6-tall block with a small corner, so the fill is painted by
             * `MdLine` from this range instead, and the span keeps only the
             * colour of the letters.
             */
            val from = builder.length
            builder.pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = chipFg, fontSize = 13.sp))
            builder.append(hit.groupValues[1])
            builder.pop()
            codeRanges.add(from until builder.length)
            at = hit.range.last + 1
        }
        if (at < source.length) emphasis(builder, source.substring(at), links, linkColor)
        return MdInline(builder.toAnnotatedString(), links, codeRanges)
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
/*
 * The selection wash, measured off the reference at 400 dpi.
 *
 * The figure this file carried before was #ECDFE6, and it was the *toolbar's*
 * colour rather than the selection's: the pill that floats above a selection
 * is pink-lilac, while the block behind the words is a peach. Reading the two
 * apart matters, because a pink wash behind pink-ish text reads as a tinted
 * page and a peach one reads as a highlighter - which is what the reference
 * looks like.
 *
 *   wash     #DEBFAF  222,190,175 - sampled inside 复制's own selection
 *   handle   #B96747  185,103,71  - the two large teardrops under it
 *   pill     #ECDFE6  236,223,230 - the 复制 / 全选 menu
 */
private var selectionTint = Color(0xFFDEBFAF)
/* The two end handles: the reference's burnt orange in light, lighter on dark. */
private var selectionHandle = Color(0xFFB96747)
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
private val PARAGRAPH_GAP = 0.dp

@Composable
fun MarkdownBody(
    source: String,
    modifier: Modifier = Modifier,
    dark: Boolean = false,
    onCopy: (String) -> Unit = {},
    /*
     * The selection this reply should use, when the caller owns it - the screen
     * does, because the message sheet's 选择文本 arms it from outside the
     * transcript. A caller that does not pass one gets a private instance.
     */
    share: SelectionState? = null,
) {
    /*
     * One drag for the whole reply.
     *
     * Held here rather than per line so a selection that starts in one paragraph
     * and runs into the next is a single run - each `MdLine` is handed this
     * instance plus its own place in the reply, and works out its slice.
     *
     * The whole selection system is local because Compose's is unreachable:
     * `SelectionRegistrar`, `LocalSelectionRegistrar` and the controlled
     * `SelectionContainer` overload are `internal` in Kotlin at every foundation
     * version checked, up to 1.10.
     */
    val sharedSelection: SelectionState = share ?: remember(source) { SelectionState() }
    val blocks = remember(source) { Md.blocks(source) }
    /*
     * Published after composition rather than during it: a drag that runs past
     * one paragraph clamps against this count, and writing it inline would be a
     * state write inside the composition that reads it.
     */
    SideEffect { sharedSelection.lineCount = blocks.size }
    val textColor = LocalText.current
    val muted = LocalMuted.current
    chipBg = if (dark) Color(0xFF2E2E2E) else Color(0xFFF0F0F2)
    chipFg = if (dark) Color(0xFFE6E6E6) else Color(0xFF3A3A38)
    selectionTint = if (dark) Color(0xFF63463A) else Color(0xFFDEBFAF)
    selectionHandle = if (dark) Color(0xFFD08A6B) else Color(0xFFB96747)
    /*
     * How many characters of the container's flat string each block owns, in
     * order. A block's own text plus the newline the container inserts after it
     * - the same arithmetic `SelectionContainer` does when it merges the
     * registered `Text`s into one selectable run.
     */
    val offsets = remember(blocks) {
        var at = 0
        blocks.map { block ->
            val start = at
            at += flatLength(block) + 1
            start
        }
    }
    /*
     * The reply's flat text, so the copy chip can take exactly what is lit
     * rather than the whole markdown source: `offsets` already say where each
     * block begins, so walking them with the selection's two ends yields the
     * words the reader actually sees selected.
     */
    val plain = remember(source) { blocks.joinToString("\n") { blockText(it) } }
    /*
     * Keyed on the four numbers, not on the state object.
     *
     * `SelectionState` is a stable instance whose fields are mutable state, so
     * remembering on the object alone would compute once and never again - the
     * chip would show the first selection for ever.
     */
    /*
     * Computed inline, in the composable body.
     *
     * Both earlier forms failed the same way: a `remember` keyed on the four
     * offsets never recomputed, and a `derivedStateOf` built once kept capturing
     * the first `blocks`/`plain`. Reading the four fields here - in composition,
     * where Compose is watching them - is what makes the chip appear and follow
     * the selection.
     */
    val selStart = if (sharedSelection.isEmpty) -1 else sharedSelection.startLine
    val selEnd = if (sharedSelection.isEmpty) -1 else sharedSelection.endLine
    val selectedText: String = if (selStart < 0) "" else {
        val a = offsets.getOrNull(selStart)
        val b = offsets.getOrNull(selEnd)
        if (a == null || b == null) "" else {
            val range = copyRange(a, sharedSelection.startOffset, b, sharedSelection.endOffset, plain.length)
            if (range == null) "" else plain.substring(range.first, range.second).trim()
        }
    }
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    /*
     * The 复制 / 全选 pill, as a `Popup` at the lit box.
     *
     * Measured off the reference's own selection on the pad at 400 dpi:
     *
     *   pill      x 1251..1530, y 207..326 - 112 by 48 dp, corner 24, filled
     *             #ECDFE6 with #382F36 lettering at about 13sp
     *   labels    复制 at 17.6 in from the pill's left, 全选 at 17.6 from its
     *             right, 25.2 between them - so the pill's own width is exactly
     *             what those three runs add up to, and it needs no fixed width
     *   gap       21 px of air between the pill's bottom and the wash's top,
     *             8.4 dp, and the pill is centred on the wash
     *
     * Two earlier shapes failed for reasons that only showed up on the device:
     * pinning it to the reply's `TopEnd` put it above the viewport whenever the
     * reply was taller than the screen and had scrolled, and a sibling inside the
     * box was drawn under the full-width column. A `Popup` sits in its own window
     * at the coordinates the line reported, so neither can happen.
     */
    val anchor = sharedSelection.anchorInRoot
    val density = androidx.compose.ui.platform.LocalDensity.current
    val pillWidth = 112.dp
    /*
     * A fixed 112 dp, centred on the wash - but the offset has to be measured
     * from the pill's own parent, not from the root.
     *
     * `Popup(offset = ...)` positions its window against the *layout that
     * contains the anchor*, and the anchor here is a root coordinate, so using
     * it directly put the pill a whole sidebar's width to the right. Routeing
     * it through `PopupPositionProvider` lets the arithmetic happen in one
     * coordinate space.
     */
    if (selectedText.isNotEmpty() && anchor != null) {
        androidx.compose.ui.window.Popup(
            popupPositionProvider = object : androidx.compose.ui.window.PopupPositionProvider {
                override fun calculatePosition(
                    anchorBounds: androidx.compose.ui.unit.IntRect,
                    windowSize: androidx.compose.ui.unit.IntSize,
                    layoutDirection: androidx.compose.ui.unit.LayoutDirection,
                    popupContentSize: androidx.compose.ui.unit.IntSize,
                ): androidx.compose.ui.unit.IntOffset {
                    /*
                     * Above the wash by 8.4 dp and centred on it; below it when
                     * there is no room above.
                     *
                     * `windowSize` is the whole window here, so the anchor's own
                     * root coordinates can be used as-is - which is the point of
                     * going through a provider at all. The clamp alone was not
                     * enough: a selection near the top of the screen had the pill
                     * pushed down onto the very words it was for, which reads as
                     * a broken popup. The reference flips it under the selection
                     * instead, so this does too - 48 for the pill, 8.4 of air,
                     * and 27.6 for the wash's own height.
                     */
                    val halfPill = with(density) { pillWidth.toPx() / 2f }
                    val above = with(density) { 56.4.dp.toPx() }
                    val below = with(density) { (48f + 8.4f + 27.6f).dp.toPx() }
                    val x = (anchor.x - halfPill).toInt()
                        .coerceIn(0, (windowSize.width - popupContentSize.width).coerceAtLeast(0))
                    val preferred = anchor.y - above
                    val y = if (preferred >= 0f) preferred.toInt()
                    else (anchor.y + below).toInt()
                        .coerceAtMost((windowSize.height - popupContentSize.height).coerceAtLeast(0))
                    return androidx.compose.ui.unit.IntOffset(x, y)
                }
            },
        ) {
            val night = LocalBg.current.luminance() < 0.4f
            Row(
                androidx.compose.ui.Modifier
                    .width(pillWidth)
                    .height(48.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(if (night) Color(0xFF3A2E33) else Color(0xFFECDFE6)),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Text(
                    "复制",
                    fontSize = 13.sp,
                    color = if (night) Color(0xFFF1E9EC) else Color(0xFF382F36),
                    modifier = androidx.compose.ui.Modifier.clickable {
                        clipboard.setText(AnnotatedString(selectedText))
                        sharedSelection.clear()
                    },
                )
                Spacer(androidx.compose.ui.Modifier.width(25.dp))
                Text(
                    "全选",
                    fontSize = 13.sp,
                    color = if (night) Color(0xFFF1E9EC) else Color(0xFF382F36),
                    modifier = androidx.compose.ui.Modifier.clickable {
                        // Every line of the reply, from its first character to
                        // its last - the reference's 全选 lights the whole
                        // message rather than the paragraph the press landed in.
                        val last = blocks.lastOrNull() ?: return@clickable
                        sharedSelection.anchorLine = 0
                        sharedSelection.anchorOffset = 0
                        sharedSelection.activeLine = blocks.lastIndex
                        sharedSelection.activeOffset = flatLength(last)
                    },
                )
            }
        }
    }
    Column(androidx.compose.ui.Modifier.fillMaxWidth()) {
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
                        sharedSelection = sharedSelection,
                        lineIndex = index,
                        /*
                         * 0, not `offsets[index]`: `lineStart` is where this
                         * `Text` begins *inside its block*, and a heading is
                         * its whole block. Mixing the two spaces here made
                         * every paragraph's slice start past the end of its own
                         * block, so nothing but a list could be lit.
                         */
                        lineStart = 0,
                    )
                }
                is MdBlock.Para -> MdLine(
                    block.text, color = textColor,
                    modifier = Modifier.padding(bottom = if (last) 0.dp else PARAGRAPH_GAP),
                    sharedSelection = sharedSelection,
                    lineIndex = index,
                    lineStart = 0,
                )
                is MdBlock.Code -> CodeBox(
                    block.lang, block.code, dark, Modifier.padding(vertical = 4.dp),
                    sharedSelection = sharedSelection,
                    lineIndex = index,
                    lineStart = 0,
                )
                is MdBlock.ListBlock -> ListBox(
                    block, textColor,
                    modifier = Modifier.padding(bottom = if (last) 0.dp else PARAGRAPH_GAP),
                    sharedSelection = sharedSelection,
                    lineIndex = index,
                    lineStart = 0,
                )
                is MdBlock.Quote -> Row(
                    Modifier
                        .padding(bottom = if (last) 0.dp else 14.dp)
                        .height(IntrinsicSize.Min),
                ) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(LocalLine.current))
                    // A quote keeps its own paragraphs, so it recurses with a
                    // step in from the rule rather than flattening to one line.
                    Column(Modifier.padding(start = 12.dp)) {
                        /*
                         * A quote is one block of the reply's flat text whose
                         * contents are several blocks joined by newlines, so
                         * each inner block's slice starts where the one before
                         * it ended - the same arithmetic a list uses. Without
                         * this, nothing inside a quote could be selected: the
                         * whole quote answered to one index and every inner
                         * `Text` claimed the selection belonged to a block it
                         * was only a part of.
                         */
                        var at = 0
                        for (inner in block.blocks) {
                            val here = at
                            at += flatLength(inner) + 1
                            when (inner) {
                                is MdBlock.Para -> MdLine(
                                    inner.text, color = muted,
                                    modifier = Modifier.padding(bottom = 6.dp),
                                    sharedSelection = sharedSelection,
                                    lineIndex = index,
                                    lineStart = here,
                                )
                                is MdBlock.Code -> CodeBox(
                                    inner.lang, inner.code, dark,
                                    sharedSelection = sharedSelection,
                                    lineIndex = index,
                                    lineStart = here,
                                )
                                is MdBlock.ListBlock -> ListBox(
                                    inner, muted,
                                    sharedSelection = sharedSelection,
                                    lineIndex = index,
                                    lineStart = here,
                                )
                                is MdBlock.Heading -> MdLine(
                                    inner.text, weight = FontWeight.SemiBold, color = muted,
                                    sharedSelection = sharedSelection,
                                    lineIndex = index,
                                    lineStart = here,
                                )
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
    size: androidx.compose.ui.unit.TextUnit = 18.sp,
    weight: FontWeight? = null,
    /*
     * 29.8dp of line, measured at the pad's real 2.5 px per dp.
     *
     * Both numbers here were a size too small, and the reason is the same
     * mistake twice over: every dp in this file was divided by 3.156, the
     * screenshot's nominal 1080 against the pad's 3408, instead of by the 2.5
     * that 400 dpi actually gives. Claude's CJK body ink measures 43 px - 17.2
     * dp - and its line pitch 75 px, 30.0 dp; this set 15sp over 24sp, whose ink
     * is 35 px. The prose therefore read a seventh smaller and a fifth tighter
     * than the reference, which is the difference the eye catches first.
     *
     * The paragraph gap stays folded into this rather than kept as a separate
     * padding: with both, a run of short paragraphs opened 4dp looser than the
     * reference's and every block sat lower than its word count called for.
     */
    lineHeight: androidx.compose.ui.unit.TextUnit = 30.sp,
    /*
     * This line's slice of the reader's selection, in *its own* offsets, or
     * null when nothing on this line is selected.
     *
     * `MarkdownBody` walks its blocks in order and converts the container's
     * whole-response range into per-line ones, because a `Text` can only speak
     * about its own `AnnotatedString`. The tint is then drawn here rather than
     * left to `SelectionContainer`, whose own fill is a bare rectangle per
     * line - see `MarkdownBody` for why that was not good enough.
     */
    sharedSelection: SelectionState? = null,
    /** This line's index within the reply, so the shared drag can be clipped to it. */
    lineIndex: Int = -1,
    /**
     * Where this line begins in the reply's flat text.
     *
     * Not subtracted from anything: `getOffsetForPosition` and
     * `getWordBoundary` already answer in this `Text`'s own coordinates, and
     * subtracting a block offset from them produced negative anchors
     * (1686 against a 94-character line) which lit nothing. Kept because the
     * copy chip still needs the map, and it documents the block's place.
     */
    lineStart: Int = 0,
) {
    val context = LocalContext.current
    val inline = remember(source, color) { MdText.inline(source, LinkBlue) }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val needle = LocalFind.current
    /*
     * This slice's part of the shared drag, in its own offsets.
     *
     * A block can be split across several `Text`s - a list is one block of the
     * reply's flat text but one `Text` per item - so `lineStart` is where this
     * slice begins inside its block, and the two are intersected here. Doing it
     * this way means a paragraph (whose slice starts at 0 and runs its whole
     * length) and a list item go through the same arithmetic, and a drag across
     * three list items lights the three of them as one continuous run.
     */
    val ownSelection: Pair<Int, Int>? =
        codeSelection(sharedSelection, lineIndex, lineStart, source.length)
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
    /*
     * Where this line was placed, so the pill can be anchored to its words.
     *
     * Held in state rather than written straight into the selection from
     * `onGloballyPositioned`: that callback fires on placement, and lighting a
     * selection moves nothing - so the write never happened on the press that
     * created the selection, and the pill never appeared. The two halves are
     * kept here and combined in an effect keyed on the selection, which runs
     * whenever the lit words change.
     */
    var placed by remember { mutableStateOf<androidx.compose.ui.layout.LayoutCoordinates?>(null) }
    /*
     * A counter, bumped whenever this line moves.
     *
     * `placed` is the same object instance across a scroll - Compose reuses the
     * coordinates node - so keying the effect on it alone kept the anchor from
     * the pre-scroll position, and the pill drifted up the screen with every
     * flick. The tick is what makes a scroll re-run the arithmetic.
     */
    var placedTick by remember { mutableStateOf(0) }
    /*
     * Where this line's top-left was on the last placement, so the tick only
     * moves when the line actually moved. Bumping it unconditionally would
     * write state from the placement callback on every pass and put the
     * composition in a loop.
     */
    var lastPlace by remember { mutableStateOf<androidx.compose.ui.geometry.Offset?>(null) }
    LaunchedEffect(sharedSelection, ownSelection, placed, layout, placedTick) {
        val shared = sharedSelection ?: return@LaunchedEffect
        val coords = placed ?: return@LaunchedEffect
        /*
         * Only the line the selection *starts* on reports an anchor.
         *
         * Every line shares one `SelectionState`, so an unselected line must
         * not write to it at all: clearing from here would race the start line's
         * write and leave the pill with no anchor - the same "nothing ever
         * appears" that took three rounds to explain. A cleared selection nulls
         * the anchor in `SelectionState.clear()` instead.
         */
        if (shared.isEmpty || lineIndex != shared.startLine) return@LaunchedEffect
        val box = ownSelection ?: return@LaunchedEffect
        val laid = layout ?: return@LaunchedEffect
        val first = chipBoxes(laid, box.first until box.second).firstOrNull() ?: return@LaunchedEffect
        shared.anchorInRoot = coords.localToRoot(
            androidx.compose.ui.geometry.Offset(
                (first.left + first.right) / 2f,
                first.top,
            ),
        )
    }
    Text(
        annotated,
        fontSize = size,
        lineHeight = lineHeight,
        color = color,
        onTextLayout = { layout = it },
        modifier = modifier
            .fillMaxWidth()
            /*
             * Inline code's fill, drawn rather than spanned.
             *
             * The reference's chip is a 29.6-tall block with a rounded corner;
             * a `SpanStyle` background is a bare rectangle behind the glyphs, so
             * every chip in this transcript had square ends while the
             * reference's are cut. The fill is painted here from the layout's own
             * boxes - one path per line, so a chip that wraps is filled as two
             * pieces rather than as one band across the column - and the span
             * keeps only the letter colour.
             */
            /*
             * Report where the lit box sits, in root coordinates.
             *
             * Two things have to hold for the pill to appear at all, and the
             * previous version only had the first: the line's coordinates, and
             * the selection itself. `onGloballyPositioned` fires when the line's
             * *placement* changes, which a selection does not do - lighting a
             * word leaves every line exactly where it was - so writing the
             * anchor inside it meant the pill never got an anchor and never
             * appeared, which matched the "it is never in the tree" checks.
             * The coordinates are kept in state here, and a `LaunchedEffect`
             * keyed on the selection does the arithmetic, so a press that lights
             * new words recomputes it while nothing has moved.
             */
            /*
             * Inline code's fill, drawn rather than spanned.
             *
             * A `SpanStyle` background is a bare rectangle behind the glyphs, so
             * every chip in this transcript had square ends while the
             * reference's are cut. The fill is painted here from the layout's own
             * boxes - one path per line, so a chip that wraps is filled as two
             * pieces rather than as one band across the column - and the span
             * keeps only the letter colour.
             *
             * Only the chip lives here now. The wash, the handles and the
             * gesture moved into `Modifier.selectable`, because a code fence
             * needs the same three and two copies of this geometry would have
             * drifted apart.
             */
            .drawBehind {
                val laid = layout ?: return@drawBehind
                if (inline.code.isEmpty()) return@drawBehind
                val corner = 4.dp.toPx()
                for (range in inline.code) {
                    for (box in chipBoxes(laid, range)) {
                        /*
                         * The glyph box is already the line's own height here -
                         * 14sp mono in a 30sp line - so the fill needs no
                         * vertical inflation. 3.6 above and below made the chip
                         * 36.8 tall against the reference's 29.6; with the box
                         * taken as it is, only the horizontal 1.6 a side
                         * remains, which is the air the reference puts before
                         * the first letter and after the last.
                         */
                        drawRoundRect(
                            color = chipBg,
                            topLeft = androidx.compose.ui.geometry.Offset(box.left - 1.6.dp.toPx(), box.top),
                            size = androidx.compose.ui.geometry.Size(
                                box.width + 3.2.dp.toPx(),
                                box.height,
                            ),
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(corner, corner),
                        )
                    }
                }
            }
            /*
             * The selection itself: wash, both handles, and the one gesture.
             *
             * `selectable` also reports where this line was placed, which is
             * what the pill is anchored to. It has to be a callback rather than
             * a write inside `onGloballyPositioned`: that fires on *placement*,
             * and lighting a word moves nothing - so the anchor was never
             * written on the press that created the selection, and the pill
             * never appeared. The coordinates land in state, and the effect
             * below recomputes whenever the lit words change.
             */
            .selectable(
                laid = layout,
                sharedSelection = sharedSelection,
                lineIndex = lineIndex,
                lineStart = lineStart,
                slice = ownSelection,
                text = annotated.text,
                onPlaced = { coords ->
                    placed = coords
                    val at = coords.localToRoot(androidx.compose.ui.geometry.Offset.Zero)
                    if (lastPlace != at) {
                        lastPlace = at
                        placedTick++
                    }
                },
            )
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

/**
 * The range of the reply's flat text the reader has lit, for the copy chip.
 *
 * The two ends live in different spaces and have to be joined with care: the
 * selection stores a block index and an offset *within that block*, so the
 * block's own position in the reply has to be added before a range can be taken
 * from the flat string.
 *
 * Two things make this worth its own function:
 *
 *  - the end offset may be `Int.MAX_VALUE`, which is the marker for "through the
 *    rest of this block" that a drag past a block's edge leaves behind. Adding
 *    it to a base in `Int` wraps round to a negative number, and the range then
 *    started after it ended - the copy chip had no text and the wash covered
 *    nothing. The addition is done in `Long` and saturated.
 *  - a dragged end can point past the text it belongs to, so both ends are
 *    clamped to the flat string's own length.
 *
 * Returns null when the range is empty, which the caller treats as "nothing
 * selected".
 */
internal fun copyRange(
    startBlockAt: Int,
    startOffset: Int,
    endBlockAt: Int,
    endOffset: Int,
    plainLength: Int,
): Pair<Int, Int>? {
    val from = (startBlockAt.toLong() + startOffset)
        .coerceIn(0L, plainLength.toLong()).toInt()
    val to = (endBlockAt.toLong() + endOffset)
        .coerceIn(from.toLong(), plainLength.toLong()).toInt()
    return if (to > from) from to to else null
}

/**
 * The overlap between a block-wide selection and one slice of that block,
 * expressed in the slice's own offsets.
 *
 * This is the whole of the selection's arithmetic, and it is deliberately free
 * of Compose so it can be tested: two of the bugs in this file came from getting
 * it wrong - a slice handed its block's offset instead of its offset *within*
 * the block, and `Int.MAX_VALUE` used as "the rest of this block" wrapping round
 * when it was added to a base.
 *
 * - `blockFrom`/`blockTo` are the two ends of the selection in block offsets.
 *   `blockTo` may be `Int.MAX_VALUE`, which means "through the end of the block";
 *   it is saturated here rather than added to anything.
 * - `sliceStart` is where this `Text` begins inside its block, and `length` is
 *   how many characters it holds.
 *
 * Returns null when the two do not overlap, which is the common case: every
 * block of a reply asks, and all but the covered ones answer null.
 */
internal fun sliceOfSelection(
    blockFrom: Int,
    blockTo: Int,
    sliceStart: Int,
    length: Int,
): Pair<Int, Int>? {
    if (length <= 0) return null
    val from = (maxOf(blockFrom, sliceStart) - sliceStart).coerceIn(0, length)
    val to = when {
        blockTo == Int.MAX_VALUE -> length
        else -> (minOf(blockTo, sliceStart + length) - sliceStart).coerceIn(0, length)
    }
    return if (to > from) from to to else null
}

/**
 * This `Text`'s part of the shared selection, in its own offsets, or null.
 *
 * A block of the reply can be split across several `Text`s - a list is one block
 * but one `Text` per item - so `lineStart` is where this slice begins inside its
 * block, and the two ranges are intersected by `sliceOfSelection`. A paragraph
 * passes a `lineStart` of 0 and its whole length; a list item passes its offset
 * within the list, so the same arithmetic serves both and a drag across three
 * items lights the three as one run.
 */
private fun codeSelection(
    shared: SelectionState?,
    lineIndex: Int,
    lineStart: Int,
    length: Int,
): Pair<Int, Int>? {
    if (shared == null || shared.isEmpty || lineIndex < 0 || length <= 0) return null
    if (lineIndex < shared.startLine || lineIndex > shared.endLine) return null
    val blockFrom = if (lineIndex == shared.startLine) shared.startOffset else 0
    val blockTo = if (lineIndex == shared.endLine) shared.endOffset else Int.MAX_VALUE
    return sliceOfSelection(blockFrom, blockTo, lineStart, length)
}

/**
 * The selection, as a modifier any text surface in a reply can wear.
 *
 * Pulled out of `MdLine` because a reply's code fences have their own face,
 * their own pitch and their own padding, and copying two hundred lines of wash,
 * handles and gesture into `CodeBox` would have meant two implementations that
 * drift apart the moment either is touched. Everything here works on a
 * `TextLayoutResult` and a block-relative slice, so a paragraph, a list item and
 * a line of code all go through the same arithmetic.
 *
 * `slice` is this `Text`'s part of the selection in its own offsets; `lineStart`
 * is where that `Text` begins inside its block, because a list is one block of
 * the reply split across several `Text`s.
 */
private fun Modifier.selectable(
    laid: TextLayoutResult?,
    sharedSelection: SelectionState?,
    lineIndex: Int,
    lineStart: Int,
    slice: Pair<Int, Int>?,
    text: CharSequence,
    onPlaced: (androidx.compose.ui.layout.LayoutCoordinates) -> Unit,
): Modifier {
    if (sharedSelection == null) return this
    return this
        .onGloballyPositioned { onPlaced(it) }
        .drawBehind {
            val result = laid ?: return@drawBehind
            drawSelectionWash(result, sharedSelection, lineIndex, slice)
        }
        .pointerInput(sharedSelection, lineIndex, lineStart) {
            val laidNow = laid ?: return@pointerInput
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val downOffset = laidNow.getOffsetForPosition(down.position)
                /*
                 * Armed by the sheet's 选择文本, one press is enough.
                 *
                 * The sheet has just told the reader "长按或拖动选择文字", so
                 * waiting out the long-press timeout again would be asking for
                 * the gesture twice. When armed, the press selects immediately
                 * and the drag below extends it - which is the behaviour that
                 * makes the menu item do something at all. Every press that is
                 * not armed still has to be held, so reading a reply is not
                 * turned into selecting it.
                 */
                val held = if (sharedSelection.armed) {
                    sharedSelection.armed = false
                    down
                } else {
                    awaitLongPressOrCancellation(down.id)
                }
                if (held == null) {
                    val cancelled = currentEvent.changes.any { it.isConsumed }
                    val moved = (currentEvent.changes.firstOrNull()?.position
                        ?: down.position) != down.position
                    if (!cancelled && !moved) sharedSelection.onDismiss?.invoke()
                    return@awaitEachGesture
                }
                held.consume()
                sharedSelection.onTakeOver?.invoke()
                if (sharedSelection.isEmpty) {
                    val word = wordAt(text, downOffset)
                    sharedSelection.anchorLine = lineIndex
                    sharedSelection.anchorOffset = lineStart + word.first
                    sharedSelection.activeLine = lineIndex
                    sharedSelection.activeOffset = lineStart + word.last + 1
                } else if (sharedSelection.endNear(lineIndex, lineStart + downOffset)) {
                    sharedSelection.moveEnd(lineIndex, lineStart + downOffset)
                } else {
                    sharedSelection.moveStart(lineIndex, lineStart + downOffset)
                }
                drag(down.id) { change ->
                    val current = laid ?: return@drag
                    val h = current.size.height.toFloat().coerceAtLeast(1f)
                    val y = change.position.y
                    val steps = when {
                        y < 0f -> -kotlin.math.ceil((-y) / h).toInt()
                        y > h -> kotlin.math.floor(y / h).toInt()
                        else -> 0
                    }
                    if (steps != 0) {
                        val target = (lineIndex + steps)
                            .coerceIn(0, (sharedSelection.lineCount - 1).coerceAtLeast(0))
                        sharedSelection.activeLine = target
                        sharedSelection.activeOffset = if (target == lineIndex) {
                            lineStart + current.getOffsetForPosition(change.position)
                        } else if (steps > 0) 0 else Int.MAX_VALUE
                    } else {
                        sharedSelection.activeLine = lineIndex
                        sharedSelection.activeOffset = lineStart + current.getOffsetForPosition(change.position)
                    }
                    change.consume()
                }
            }
        }
}

/**
 * The wash and its two handles, for one `Text`'s slice of a selection.
 *
 * Shared by every surface that can be selected: the geometry was read off the
 * reference once and lives here only, so a list and a paragraph cannot disagree
 * about how tall the block is.
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSelectionWash(
    laid: TextLayoutResult,
    shared: SelectionState,
    lineIndex: Int,
    slice: Pair<Int, Int>?,
) {
    val radius = 4.dp.toPx()
    val wash = slice?.let { (a, b) -> TextRange(a, b) }
    if (wash == null || wash.collapsed) return
    val boxes = chipBoxes(laid, wash.start until wash.end)
    for (box in boxes) {
        val left = box.left - 0.8.dp.toPx()
        val right = box.right + 0.8.dp.toPx()
        val top = box.top + 1.2.dp.toPx()
        val bottom = box.bottom - 1.2.dp.toPx()
        drawRoundRect(
            color = selectionTint,
            topLeft = androidx.compose.ui.geometry.Offset(left, top),
            size = androidx.compose.ui.geometry.Size(right - left, bottom - top),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius, radius),
        )
    }
    /*
     * Each handle hangs off the band that actually holds its own end.
     *
     * `chipBoxes` returns one box per wrapped line, in reading order, so a
     * paragraph that wraps has its start on the first box and its end on the
     * last. Taking the first box for both put the end disc up beside the
     * paragraph's first line - which is why a selection of a long paragraph
     * showed both discs at the top.
     */
    val disc = 12.6.dp.toPx()
    val overlap = 1.6.dp.toPx()
    if (lineIndex == shared.startLine) {
        val first = boxes.firstOrNull()
        if (first != null) {
            val x = first.left - 0.8.dp.toPx() - disc
            val y = first.bottom - 1.2.dp.toPx() + disc - overlap
            drawCircle(color = selectionHandle, radius = disc, center = androidx.compose.ui.geometry.Offset(x, y))
        }
    }
    if (lineIndex == shared.endLine) {
        val last = boxes.lastOrNull()
        if (last != null) {
            val x = last.right + 0.8.dp.toPx() + disc
            val y = last.bottom - 1.2.dp.toPx() + disc - overlap
            drawCircle(color = selectionHandle, radius = disc, center = androidx.compose.ui.geometry.Offset(x, y))
        }
    }
}

/**
 * A block as plain text, matching `flatLength` exactly.
 *
 * The copy chip must take the words the reader sees, not the markdown, so the
 * two functions have to agree character for character: `flatLength` reserves the
 * offsets and this consumes them. Lists join their items with newlines because
 * each item is registered as its own `Text`; that is the same newline the offset
 * table already accounts for.
 */
private fun blockText(block: MdBlock): String = when (block) {
    is MdBlock.Heading -> block.text
    is MdBlock.Para -> block.text
    is MdBlock.Code -> block.code
    is MdBlock.ListBlock -> block.items.joinToString("\n") { it.text }
    is MdBlock.Quote -> block.blocks.joinToString("\n") { blockText(it) }
    is MdBlock.Table -> (listOf(block.head) + block.rows).joinToString("\n") { it.joinToString(" ") }
    MdBlock.Rule -> ""
}

/**
 * How many characters a block contributes to the reply's flat text.
 *
 * Deliberately the length of `blockText(block)` rather than a sum of the parts:
 * the two used to be written separately and disagreed the moment a block joined
 * its pieces with a newline (a list, a quote, a table), so the offset table and
 * the text drifted apart and every selection after the first list landed on the
 * wrong characters. One function now feeds both, and they cannot disagree.
 */
private fun flatLength(block: MdBlock): Int = blockText(block).length

/**
 * What the reader has selected, held by the reply rather than by a container.
 *
 * `SelectionContainer` is not used at all: its fill cannot be rounded, and the
 * hook that would let a line draw its own is `internal`. So the state is a plain
 * holder - the anchor line and offset where the drag began, and the moving end -
 * and every `MdLine` reads it to decide whether it is covered.
 *
 * Lines share one instance, so a drag that starts in one paragraph and runs into
 * the next keeps a single continuous range: each line asks the state for its own
 * slice by adding its offset within the reply.
 */
class SelectionState {
    /** Where the drag began - the line and offset the finger first landed on. */
    var anchorLine by mutableStateOf(-1)
    var anchorOffset by mutableStateOf(0)
    /** Where the drag has reached. */
    var activeLine by mutableStateOf(-1)
    var activeOffset by mutableStateOf(0)

    /*
     * Whether the reader asked for selection from the message sheet.
     *
     * The reference does not bind its long press to the text: its sheet carries
     * 选择文本 as an item. So picking that item arms the reply, and the next
     * press on a word lights it - no second long hold, which is what the sheet
     * has just told the reader to do ("长按或拖动选择文字").
     *
     * This was written by the sheet and read by nobody, so the item did nothing
     * at all. It is read in `selectable` now: armed, a plain press selects
     * instead of waiting out the long-press timeout.
     */
    var armed by mutableStateOf(false)

    /*
     * Clears the other replies when this one is picked.
     *
     * Every reply owns its own state - the screen keys them by message id - so
     * without this, lighting a second reply left the first one still lit and its
     * 复制 chip still floating. The reference never shows two, and a second wash
     * on screen reads as a bug rather than as a second selection.
     */
    var onTakeOver: (() -> Unit)? = null

    /*
     * Turns every reply's wash off when the reader taps elsewhere.
     *
     * The reference clears the whole screen's selection on a tap outside it,
     * not just the paragraph that was touched: two replies can never be lit at
     * once, so "stop selecting" is a screen-wide statement. The screen wires
     * this to a single shared handler that walks every reply it has kept state
     * for; a reply standing alone leaves it null and simply clears itself.
     */
    var onDismiss: (() -> Unit)? = null

    /*
     * How many lines the reply has, so a drag can be clamped to it.
     *
     * Set by `MarkdownBody` once it has parsed its blocks: a drag that leaves
     * one line's own `Text` steps the active end by whole lines, and without a
     * count it would run off the end of the reply and write offsets no line can
     * map.
     */
    var lineCount by mutableStateOf(0)

    /*
     * Where the selected box sits on screen, for the 复制 chip.
     *
     * The chip cannot be anchored to the reply: a reply taller than the viewport
     * has its top scrolled away, so a chip pinned to `TopEnd` renders above the
     * visible area and looks like it was never drawn - which is exactly what the
     * last few checks kept concluding. The line reports the box in root
     * coordinates instead, and the chip is placed by a `Popup` at that point, so
     * it follows the words wherever they are.
     */
    var anchorInRoot by mutableStateOf<androidx.compose.ui.geometry.Offset?>(null)

    val isEmpty: Boolean get() = anchorLine < 0

    /*
     * The two ends, ordered - a backward drag means the anchor is the end, not
     * the start. Handles and the copy chip both address these, not the raw
     * anchor/active pair, so "drag the left handle left" keeps working whichever
     * direction the selection was made in.
     */
    private val ordered: Pair<Pair<Int, Int>, Pair<Int, Int>>
        get() {
            val a = anchorLine to anchorOffset
            val b = activeLine to activeOffset
            val aFirst = a.first < b.first || (a.first == b.first && a.second <= b.second)
            return if (aFirst) a to b else b to a
        }

    val startLine: Int get() = ordered.first.first
    val startOffset: Int get() = ordered.first.second
    val endLine: Int get() = ordered.second.first
    val endOffset: Int get() = ordered.second.second

    /** True when this line's index falls inside the drag, start or end line included. */
    fun coversLine(index: Int): Boolean = !isEmpty && index in startLine..endLine

    /** Which end a touch belongs to: the nearer of the two, by line then offset. */
    fun endNear(line: Int, offset: Int): Boolean {
        val toStart = kotlin.math.abs(line - startLine) * 1000 + kotlin.math.abs(offset - startOffset)
        val toEnd = kotlin.math.abs(line - endLine) * 1000 + kotlin.math.abs(offset - endOffset)
        return toEnd <= toStart
    }

    /** Replace the far end - used when a drag starts inside an existing selection. */
    fun moveEnd(line: Int, offset: Int) {
        /*
         * The surviving end keeps its own line as well as its own offset.
         *
         * `anchorOffset` was being reset to `startOffset` while `anchorLine` was
         * set to `startLine` - but the offset is only meaningful against the
         * line it came from, so a selection that spanned two paragraphs and was
         * then grabbed at its far end moved the fixed end back onto the wrong
         * paragraph's character count.
         */
        anchorLine = startLine
        anchorOffset = startOffset
        activeLine = line
        activeOffset = offset
    }

    fun moveStart(line: Int, offset: Int) {
        anchorLine = endLine
        anchorOffset = endOffset
        activeLine = line
        activeOffset = offset
    }

    fun clear() {
        anchorLine = -1
        activeLine = -1
        anchorOffset = 0
        activeOffset = 0
        armed = false
        anchorInRoot = null
    }
}

/**
 * The word around `offset`, by ICU's rules.
 *
 * `TextLayoutResult.getWordBoundary` is not enough here: the iterator behind it
 * has no dictionary for scripts written without spaces, so a long press in a
 * Chinese sentence returned the whole run - on the pad that lit three
 * paragraphs from one press. `android.icu.text.BreakIterator` is the same
 * segmenter the system's own text selection uses, and it splits 色温 out of
 * 看,色温从生产线 the way a reader would.
 *
 * Offsets are the string's, which is what `MdLine` already works in: the
 * annotated text keeps the source's characters one for one.
 */
private fun wordAt(text: CharSequence, offset: Int): IntRange {
    if (text.isEmpty()) return 0..0
    val at = offset.coerceIn(0, text.length - 1)
    /*
     * `Locale.SIMPLIFIED_CHINESE`, not the default.
     *
     * ICU only loads a dictionary for the languages that need one, and the
     * default instance on this pad came back character by character: a press on
     * 色温 reported the single 色. Naming the language is what asks for the
     * segmenter instead of the fallback.
     */
    val iterator = android.icu.text.BreakIterator.getWordInstance(java.util.Locale.SIMPLIFIED_CHINESE)
    iterator.setText(text.toString())
    /*
     * Forward, then back.
     *
     * `preceding` and `following` both move the iterator, so asking for the
     * start first left the second call walking on from wherever the first one
     * stopped - which returned `4..4` for a press at 3, one character instead
     * of a word. Bounding forward from the press and then stepping back to the
     * boundary before that end is stable whichever side of the word the press
     * lands on.
     */
    val end = iterator.following(at).coerceAtMost(text.length)
    val start = if (end <= 0) at else iterator.preceding(end).coerceAtLeast(0)
    /*
     * A press on a space or a comma segments as whitespace with no letters in
     * it; widening to the next word is what the reference does, and it keeps a
     * press between two words from lighting nothing.
     */
    val slice = text.subSequence(start, end.coerceAtLeast(start)).toString()
    if (slice.isBlank() || slice.none { it.isLetterOrDigit() }) {
        val next = iterator.following(end).coerceAtMost(text.length)
        if (next > end) {
            val after = iterator.following(next).coerceAtMost(text.length)
            return end until after.coerceAtLeast(end + 1)
        }
    }
    return start until end.coerceAtLeast(start + 1)
}

/**
 * The boxes an inline chip covers, one per line it spans.
 *
 * `getBoundingBox(start, end)` answers the union of a slice, which for a chip
 * that wraps is a rectangle reaching from the end of one line to the start of
 * the next - a band across the column. Walking the lines instead gives one box
 * per run of characters the chip actually owns, so a wrapped chip is filled as
 * two pieces the way the reference draws it.
 */
private fun chipBoxes(laid: androidx.compose.ui.text.TextLayoutResult, range: IntRange): List<androidx.compose.ui.geometry.Rect> {
    if (range.isEmpty()) return emptyList()
    /*
     * Per character, merged along their line.
     *
     * This Compose ships only `getBoundingBox(offset: Int)` - the slice overload
     * is not in the API at this version - so the chip is accumulated one glyph
     * at a time and each run is closed when the line changes. The union is the
     * glyph box, which is what the fill wants anyway: it is inflated by the
     * caller for the reference's padding.
     */
    val out = mutableListOf<androidx.compose.ui.geometry.Rect>()
    var run: androidx.compose.ui.geometry.Rect? = null
    var runLine = -1
    for (offset in range) {
        val line = laid.getLineForOffset(offset)
        val box = laid.getBoundingBox(offset)
        if (run == null || line != runLine) {
            run?.let { out.add(it) }
            run = box
            runLine = line
        } else {
            run = androidx.compose.ui.geometry.Rect(
                left = minOf(run.left, box.left),
                top = minOf(run.top, box.top),
                right = maxOf(run.right, box.right),
                bottom = maxOf(run.bottom, box.bottom),
            )
        }
    }
    run?.let { out.add(it) }
    return out
}

/**
 * A fenced block, measured off Claude's own card on the pad.
 *
 * Every figure here was read at the pad's real 2.5 px per dp; the previous
 * version had all of them divided by 3.156 and so ran about a quarter large,
 * and it drew a white card with a rule under the head where Claude draws a
 * single warm plate with no rule at all.
 *
 *   card     x 1274..3093, 728 dp wide, 135.6 dp in from the pane and 126.0
 *            from its far edge - the same inset as the prose beside it
 *   fill     #F0EFEC for the head band, #F3F3F0 for the body; on the page's
 *            #F9F9F7 that is a card and not a hole
 *   head     40.0 dp tall, the language 17.2 dp in and 15.2 dp down, 12sp
 *   rule     none - the two fills differ by three levels, and the original
 *            reads the change of plate as the rule
 *   body     code 17.2 dp in, first line 58.0 dp from the card's top, 16.4 dp
 *            of line pitch, last line 16.8 dp off the bottom
 *   corner   22.4 dp, the same as the composer's
 */
@Composable
private fun CodeBox(
    lang: String,
    code: String,
    dark: Boolean,
    modifier: Modifier = Modifier,
    /*
     * A fence is selectable too.
     *
     * The reference lets a reader light a line of code and copy it, and this
     * block was the one part of a reply where nothing could be selected at all.
     * `Highlight.colorize` keeps the source's characters one for one - it only
     * adds colours - so the offsets a selection reports are the code's own, and
     * the same `MdLine` arithmetic can be used. The one thing it cannot share is
     * `MdLine` itself: this block has its own mono face, its own pitch and its
     * own padding, so the selection drawing and the gesture are attached to the
     * `Text` here instead.
     */
    sharedSelection: SelectionState? = null,
    lineIndex: Int = -1,
    lineStart: Int = 0,
) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(code) { mutableStateOf(false) }
    var expanded by remember(code) { mutableStateOf(false) }
    /*
     * A code fence selects like prose does.
     *
     * The reference lets a reader light a line of code and copy just that, and
     * this block was the one part of a reply where no word could be selected at
     * all. `Highlight.colorize` only adds colours, never characters, so the
     * offsets a selection reports are the code's own - which is what lets the
     * shared `selectable` modifier work here unchanged.
     */
    var codeLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
    var codePlaced by remember { mutableStateOf<androidx.compose.ui.layout.LayoutCoordinates?>(null) }
    var codeTick by remember { mutableStateOf(0) }
    var codeLast by remember { mutableStateOf<androidx.compose.ui.geometry.Offset?>(null) }
    /*
     * The pill's anchor, for a selection that starts inside this fence.
     *
     * Same shape as `MdLine`'s: the coordinates are state and the arithmetic
     * runs in an effect keyed on the selection, because lighting a word does not
     * move anything and `onGloballyPositioned` therefore never fires for it.
     */
    LaunchedEffect(sharedSelection, codeLayout, codePlaced, codeTick) {
        val shared = sharedSelection ?: return@LaunchedEffect
        val coords = codePlaced ?: return@LaunchedEffect
        if (shared.isEmpty || lineIndex != shared.startLine) return@LaunchedEffect
        val laid = codeLayout ?: return@LaunchedEffect
        val slice = codeSelection(shared, lineIndex, lineStart, code.length) ?: return@LaunchedEffect
        val first = chipBoxes(laid, slice.first until slice.second).firstOrNull() ?: return@LaunchedEffect
        shared.anchorInRoot = coords.localToRoot(
            androidx.compose.ui.geometry.Offset((first.left + first.right) / 2f, first.top),
        )
    }
    val head = if (dark) Color(0xFF262626) else Color(0xFFF0EFEC)
    val body = if (dark) Color(0xFF2E2E2E) else Color(0xFFF3F3F0)
    val ink = if (dark) Color(0xFFB8B8B8) else Color(0xFF6B6862)
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.4.dp))
            .background(body),
    ) {
        Row(
            Modifier.fillMaxWidth().background(head).height(40.dp).padding(start = 17.2.dp, end = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                lang.ifEmpty { "code" },
                fontSize = 12.sp,
                color = ink,
                modifier = Modifier.weight(1f),
            )
            /*
             * Two marks, as Claude's head carries: copy and expand. Expand has
             * nothing to open into on this pane - there is no full-screen code
             * sheet yet - so it is drawn inert, at the same size as its
             * neighbour so the pair reads as a pair.
             */
            Row(
                Modifier
                    .clickable {
                        clipboard.setText(AnnotatedString(code))
                        copied = true
                    }
                    .padding(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy,
                    contentDescription = if (copied) "已复制" else "复制",
                    tint = if (copied) Color(0xFF00C950) else ink,
                    modifier = Modifier.size(15.dp),
                )
            }
            Spacer(Modifier.width(2.dp))
            /*
             * Expand, for real: a full screen sheet with the block on it.
             *
             * The mark was drawn at 55% and did nothing, which is the one thing
             * a control must not do. The sheet is the same card at the screen's
             * own size, scrolling rather than wrapping.
             */
            Box(
                Modifier.size(19.dp).clickable { expanded = true },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.OpenInFull,
                    contentDescription = "展开",
                    tint = ink,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
        if (expanded) {
            androidx.compose.ui.window.Dialog(onDismissRequest = { expanded = false }) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(if (dark) Color(0xFF1F1F1F) else Color(0xFFFFFEFD), RoundedCornerShape(22.4.dp))
                        .padding(16.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(lang.ifEmpty { "code" }, fontSize = 13.sp, color = ink, modifier = Modifier.weight(1f))
                        Box(
                            Modifier.size(28.dp).clickable {
                                clipboard.setText(AnnotatedString(code))
                                copied = true
                            },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy,
                                contentDescription = if (copied) "已复制" else "复制",
                                tint = if (copied) Color(0xFF00C950) else ink,
                                modifier = Modifier.size(16.dp),
                            )
                        }
                        Box(
                            Modifier.size(28.dp).clickable { expanded = false },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Filled.Close, contentDescription = "关闭", tint = ink, modifier = Modifier.size(18.dp))
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Text(
                        Highlight.colorize(code, lang, if (dark) Highlight.dark else Highlight.light),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        lineHeight = 18.sp,
                        color = LocalText.current,
                        softWrap = true,
                        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
        /*
         * A long line wraps instead of scrolling sideways.
         *
         * Sideways scrolling in a phone transcript is a poor affordance: the
         * swipe has to start inside one card, fights the vertical scroll of the
         * thread, and gives no sign that it is even possible - the line simply
         * ended and read as cut off. Claude wraps a long line inside the card,
         * keeping its indent so it still reads as code.
         *
         * 16.4 dp of pitch, from three lines 41 px apart: at 400 dpi that is
         * 14sp set solid, not the 22sp of leading the old fixed line height
         * gave.
         */
        /*
         * Coloured, not monochrome.
         *
         * Everything else on this pane had been measured against the reference
         * while this one block still arrived in a single grey - and code is the
         * one block a reader scans by shape rather than reads. `Highlight`
         * carries the six inks, read off the pad's own Python, and the colour
         * for plain punctuation is the block's own text colour so the code that
         * has no keyword in it still matches the rest of the reply.
         */
        Text(
            Highlight.colorize(code, lang, if (dark) Highlight.dark else Highlight.light),
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            lineHeight = 16.4.sp,
            color = LocalText.current,
            softWrap = true,
            onTextLayout = { codeLayout = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 17.2.dp, end = 17.2.dp, top = 15.6.dp, bottom = 16.8.dp)
                .selectable(
                    laid = codeLayout,
                    sharedSelection = sharedSelection,
                    lineIndex = lineIndex,
                    lineStart = lineStart,
                    slice = codeSelection(sharedSelection, lineIndex, lineStart, code.length),
                    text = code,
                    onPlaced = { coords ->
                        codePlaced = coords
                        val at = coords.localToRoot(androidx.compose.ui.geometry.Offset.Zero)
                        if (codeLast != at) {
                            codeLast = at
                            codeTick++
                        }
                    },
                ),
        )
    }
}

@Composable
private fun ListBox(
    block: MdBlock.ListBlock,
    color: Color,
    modifier: Modifier = Modifier,
    /*
     * A list is one block of the reply's flat text, so every item is a slice of
     * it rather than a line of its own.
     *
     * `blockText` joins a list's items with a newline, which means item `n`
     * begins at the block's offset plus the lengths of every item before it and
     * one newline each. Passing that through lets a drag select a list the way
     * it selects a paragraph - before this, a list was the one block in the
     * transcript where no word could be lit at all.
     */
    sharedSelection: SelectionState? = null,
    lineIndex: Int = -1,
    lineStart: Int = 0,
) {
    Column(modifier.fillMaxWidth()) {
        var number = block.start
        var at = lineStart
        for (item in block.items) {
            val marker = when {
                item.task -> if (item.checked) "✓" else "○"
                block.ordered -> "${number++}."
                else -> "•"
            }
            val here = at
            at += item.text.length + 1
            Row(Modifier.fillMaxWidth().padding(start = (item.depth * 16).dp, bottom = 6.dp)) {
                Text(
                    marker,
                    /*
                     * The same size and pitch as the prose beside it, which is
                     * what Claude's lists use. 17sp over 26sp was a reading of
                     * "ink 36 px, pitch 107 px" divided by the same 3.156 that
                     * made every other dp in this file 26% too large - so it
                     * came out a step under the body it sits in rather than
                     * level with it. `MdLine`'s own 18/30 is the truth.
                     */
                    fontSize = 18.sp,
                    lineHeight = 30.sp,
                    color = if (item.task && !item.checked) LocalMuted.current else color,
                    modifier = Modifier.width(if (block.ordered) 24.dp else 16.dp),
                )
                MdLine(
                    item.text,
                    color = color,
                    modifier = Modifier.weight(1f),
                    sharedSelection = sharedSelection,
                    lineIndex = lineIndex,
                    lineStart = here,
                )
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