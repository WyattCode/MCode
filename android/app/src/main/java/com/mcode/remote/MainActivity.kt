package com.mcode.remote

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.core.graphics.PathParser
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/* ------------------------------------------------------------------ */
/* Palette - Claude Code's warm cream and ink                          */
/* ------------------------------------------------------------------ */

private val Cream = Color(0xFFF9F9F7)
private val CreamSurface = Color(0xFFFEFEFE)
private val CreamPill = Color(0xFFF0EFEC)
private val CreamLine = Color(0xFFE4E1D8)
private val Ink = Color(0xFF1F1E1C)
private val InkMuted = Color(0xFF6B6862)
/*
 * The mark's own orange, measured off Claude's empty pane on the fold:
 * (204,124,94) where this used #D97757 = (217,119,87) - the same family but a
 * redder, less dusty tone, which showed most at the 40dp mark.
 */
private val Ember = Color(0xFFCC7C5E)

/**
 * A patch's two inks, per scheme.
 *
 * `--diff-add` / `--diff-delete`: #20a923 and #e5351c in light, #a3da9f and
 * #ffb3a4 in dark. The phone held one pair of dark greens and reds for both
 * schemes, so on the dark page a diff's added lines came out a near-black green
 * that could not be read at all - and a patch is the commonest thing a tool
 * row prints.
 */
@Composable
fun diffAddInk(): Color = if (LocalBg.current == DarkBg) Color(0xFFA3DA9F) else Color(0xFF20A923)

@Composable
fun diffDelInk(): Color = if (LocalBg.current == DarkBg) Color(0xFFFFB3A4) else Color(0xFFE5351C)


/**
 * A row of one of the app's menus, on the desktop's own measurements.
 *
 * `AppMenu.vue`: 28 tall, 12 in from each edge, a 4 corner, 13sp at the body's
 * weight. Material's `DropdownMenuItem` is 48 tall with a 14sp label and 16 of
 * inset, which on a tablet made every menu read as a list of large buttons
 * rather than as the compact menu the desktop shows. `leading` is the 18dp mark
 * the desktop puts at the head of a row; `trailing` is the shortcut hint it
 * prints at the end.
 */
@Composable
fun MenuRow(
    label: String,
    onClick: () -> Unit,
    /** The mark at the row's end - the desktop puts it there, not at the head. */
    icon: (@Composable () -> Unit)? = null,
    trailing: String? = null,
    danger: Boolean = false,
) {
    val ink = if (danger) MaterialTheme.colorScheme.error else LocalText.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 28.dp)
            .clip(RoundedCornerShape(4.dp))
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 13.sp, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            Text(trailing, fontSize = 11.sp, color = LocalMuted.current)
        }
        if (icon != null) {
            /*
             * `.row` is `space-between` with the svg 4 OUT of the end
             * (`margin-inline-end: -4px`), so the mark hangs against the menu's
             * own edge rather than sitting in a leading column. A leading icon
             * also pushed every label right by 26, which no desktop menu does.
             */
            Spacer(Modifier.width(10.dp))
            Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) { icon() }
        }
    }
}

/**
 * One of the desktop's own icons, drawn from its `d` string.
 *
 * The phone used Material's nearest lookalike for each of these - a speech
 * bubble, a tray, a code mark - and the shapes were close but never the same:
 * Claude's new-task bubble carries its tail at the lower left and its plus in
 * the middle, its tray is open at the top with the screen resting in it, and
 * its conversation mark has the tail cut into the outline rather than hanging
 * below it. The desktop ships all of these as literal paths, so the phone
 * draws the same ones: `stroke-width` and the viewBox come from the same svg,
 * and the size is whatever the row gives it.
 */
@Composable
fun MiIcon(
    path: String,
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
    viewBox: Float = 24f,
    strokeWidth: Float = 2f,
    tint: Color = LocalText.current,
) {
    Canvas(modifier) {
        val scale = size.width / viewBox
        withTransform({
            scale(scale, scale, pivot = Offset.Zero)
        }) {
            // androidx's parser reads the full SVG grammar - the arcs in the
            // new-task bubble included - and converts in one step.
            val parsed = androidx.core.graphics.PathParser.createPathFromPathData(path).asComposePath()
            drawPath(
                parsed,
                color = tint,
                style = Stroke(strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
    }
}
/*
 * The dot at the end of a conversation row, measured off Claude on the fold:
 * 22px across at its 450dpi (7.8dp), grey (139,137,132) when the conversation
 * is still, blue (65,118,207) while a turn is running. Claude draws one on
 * every row - the colour is the state, not the presence.
 */
private val DotBlue = Color(0xFF4176CF)
private val DotGrey = Color(0xFF8B8984)

/*
 * Dark, sampled off Claude's own dark empty state on the fold at 450 dpi:
 * the page is #151515, the composer card #20201F (not the #18191B an earlier
 * pass recorded), and every soft circle is #313131. The search field is a
 * shade above the page with a visible #484847 hairline.
 */
private val DarkBg = Color(0xFF151515)
private val DarkSurface = Color(0xFF20201F)
private val DarkPill = Color(0xFF313131)
private val DarkField = Color(0xFF1A1A19)
private val DarkFieldLine = Color(0xFF484847)
private val DarkLine = Color(0xFF232323)
private val DarkText = Color(0xFFF5F4EF)
private val DarkMuted = Color(0xFF888681)

val LocalBg = staticCompositionLocalOf { Cream }
val LocalSurface = staticCompositionLocalOf { CreamSurface }
val LocalText = staticCompositionLocalOf { Ink }
val LocalMuted = staticCompositionLocalOf { InkMuted }
val LocalPill = staticCompositionLocalOf { CreamPill }
/** The user's own turn: a shade under the page in dark (13,13,13 on the pad), not above it. */
val LocalBubble = staticCompositionLocalOf { CreamPill }
/** Type on the reader's own turn: ink on paper, because the bubble is paper in both themes. */
val LocalBubbleText = staticCompositionLocalOf { Ink }
val LocalLine = staticCompositionLocalOf { CreamLine }
/** The search field's fill and hairline: white on cream, #1A1A19 on #151515. */
val LocalField = staticCompositionLocalOf { CreamSurface }
val LocalFieldLine = staticCompositionLocalOf { CreamPill }

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/**
 * What a tool call was about, named the way the desktop names it.
 *
 * The same field order `stepTitle` uses in the renderer: the path for a file
 * tool, the command for a shell, the pattern for a search, the url for a
 * fetch - falling back to whatever title the server put on the part.
 */
fun toolTitleOf(part: JSONObject): String {
    val input = part.optJSONObject("input")
    val named = when (part.optString("name")) {
        "read", "edit", "write", "apply_patch", "patch" -> input?.optString("path")
            ?: input?.optString("filePath") ?: input?.optString("file_path")
        "bash", "exec_command" -> input?.optString("description") ?: input?.optString("command") ?: input?.optString("cmd")
        // A search pattern often arrives as `**/name`; the glob part says
        // nothing on a phone row, so it is dropped.
        "grep", "glob" -> input?.optString("pattern")?.removePrefix("**/")?.removePrefix("./")
        "webfetch", "websearch" -> input?.optString("url") ?: input?.optString("query")
        else -> null
    }
    val fallback = part.optString("title")
    return (named?.takeIf { it.isNotBlank() } ?: fallback).take(120)
}

/**
 * The verb in front of a tool's title, from MCode's own word list so the phone
 * says what the desktop says: 已读取 / 正在读取 / 读取失败 / 已拒绝读取 /
 * 未执行：读取 / 未完成.
 */
/**
 * What a tool call is doing, in the desktop's own words.
 *
 * These are the strings `toolLabel.done/running/error/rejected/skipped.*`
 * carries in `lib/i18n.ts`, copied rather than rebuilt: the phone used to
 * assemble its own (`"已" + "命令"` became 已命令, which is not Chinese), and a
 * second wording would drift from the desktop the first time either changed.
 */
fun toolVerbOf(name: String, status: String): String {
    val base = when (name) {
        "read" -> "read"
        "edit", "apply_patch", "patch" -> "edit"
        "write" -> "write"
        "bash", "exec_command" -> "bash"
        "execute" -> "execute"
        "grep" -> "grep"
        "glob" -> "glob"
        "list" -> "list"
        "webfetch" -> "webfetch"
        "websearch" -> "websearch"
        "app" -> "app"
        "todowrite" -> "todowrite"
        "skill" -> "skill"
        "skill_search" -> "skill_search"
        "present_files" -> "present_files"
        "pdf_locate" -> "pdf_locate"
        else -> ""
    }
    val doing = when (status) {
        "running", "pending", "in_progress" -> "running"
        "error", "failed" -> "error"
        "rejected" -> "rejected"
        "skipped" -> "skipped"
        else -> "done"
    }
    val label = TOOL_LABELS["$doing.$base"] ?: TOOL_LABELS["$doing.read"]
    return label ?: name.ifEmpty { "工具" }
}

/** The desktop's tool labels, verbatim (zhCN table). */
private val TOOL_LABELS = mapOf(
    "done.read" to "已读取",
    "done.edit" to "已编辑",
    "done.write" to "已写入",
    "done.bash" to "已执行命令",
    "done.grep" to "已搜索",
    "done.glob" to "已搜索",
    "done.list" to "已列目录",
    "done.webfetch" to "已读取网页",
    "done.websearch" to "已搜索网络",
    "done.execute" to "已运行代码模式脚本",
    "done.app" to "已操作应用",
    "done.todowrite" to "更新待办",
    "done.skill" to "使用技能",
    "done.skill_search" to "搜索技能",
    "done.present_files" to "展示文件",
    "done.pdf_locate" to "定位 PDF",
    "running.read" to "正在读取",
    "running.edit" to "正在编辑",
    "running.write" to "正在写入",
    "running.bash" to "正在执行命令",
    "running.grep" to "正在搜索",
    "running.glob" to "正在搜索",
    "running.list" to "正在列目录",
    "running.webfetch" to "正在读取网页",
    "running.websearch" to "正在搜索网络",
    "running.execute" to "正在运行代码模式脚本",
    "running.app" to "正在操作应用",
    "running.todowrite" to "正在更新待办",
    "running.skill" to "正在使用技能",
    "running.skill_search" to "正在搜索技能",
    "running.present_files" to "正在展示文件",
    "running.pdf_locate" to "正在定位 PDF",
    "error.read" to "读取失败",
    "error.edit" to "编辑失败",
    "error.write" to "写入失败",
    "error.bash" to "命令执行失败",
    "error.grep" to "搜索失败",
    "error.glob" to "搜索失败",
    "error.list" to "列目录失败",
    "error.webfetch" to "读取网页失败",
    "error.websearch" to "搜索网络失败",
    "error.execute" to "代码模式脚本失败",
    "error.app" to "操作应用失败",
    "error.todowrite" to "待办更新失败",
    "error.skill" to "技能执行失败",
    "error.skill_search" to "技能搜索失败",
    "error.present_files" to "展示文件失败",
    "error.pdf_locate" to "PDF 定位失败",
    "rejected.read" to "已拒绝读取",
    "rejected.edit" to "已拒绝编辑",
    "rejected.write" to "已拒绝写入",
    "rejected.bash" to "已拒绝执行",
    "rejected.grep" to "已拒绝搜索",
    "rejected.glob" to "已拒绝搜索",
    "rejected.list" to "已拒绝列目录",
    "rejected.webfetch" to "已拒绝读取网页",
    "rejected.websearch" to "已拒绝搜索网络",
    "rejected.execute" to "已拒绝运行代码模式脚本",
    "rejected.app" to "已拒绝操作应用",
    "rejected.todowrite" to "已拒绝更新待办",
    "rejected.skill" to "已拒绝使用技能",
    "rejected.skill_search" to "已拒绝搜索技能",
    "rejected.present_files" to "已拒绝展示文件",
    "rejected.pdf_locate" to "已拒绝定位 PDF",
    "skipped.read" to "未执行：读取",
    "skipped.edit" to "未执行：编辑",
    "skipped.write" to "未执行：写入",
    "skipped.bash" to "未执行：命令",
    "skipped.grep" to "未执行：搜索",
    "skipped.glob" to "未执行：搜索",
    "skipped.list" to "未执行：列目录",
    "skipped.webfetch" to "未执行：读取网页",
    "skipped.websearch" to "未执行：搜索网络",
    "skipped.execute" to "未执行：代码模式脚本",
    "skipped.app" to "未执行：操作应用",
    "skipped.todowrite" to "未执行：更新待办",
    "skipped.skill" to "未执行：使用技能",
    "skipped.skill_search" to "未执行：搜索技能",
    "skipped.present_files" to "未执行：展示文件",
    "skipped.pdf_locate" to "未执行：定位 PDF",
)

/** Monotone ids for error rows, so two of them can never collide. */
private var errCounter = 0
private fun nextErrId(): Int = ++errCounter

sealed class Item {
    abstract val key: String
    /**
     * One turn's words.
     *
     * `finish` is the engine's sentence on how the turn ended -
     * `end_turn`, `max_tokens`, `aborted`, `error` or `refusal` - and the phone
     * only ever asked whether it was blank. A reply cut at the model's limit
     * therefore arrived looking like a finished answer: the words simply
     * stopped, and nothing said they had been truncated.
     */
    data class Msg(
        val id: String,
        val role: String,
        var text: String,
        val images: List<String> = emptyList(),
        val at: Long = 0L,
        val steered: Boolean = false,
        val files: List<String> = emptyList(),
        val finish: String = "",
        /** Characters of thinking the turn produced, which the phone does not draw. */
        val thought: Int = 0,
        /**
         * The turn's file changes were taken back with the card's 撤销. The
         * words stay; only the files moved, so the card says so in place of its
         * counts (`EditedFilesCard.vue`'s `reverted`).
         */
        val reverted: Boolean = false,
    ) : Item() { override val key = "msg.$id" }

    /**
     * Claude's wave divider: a wavy rule across the pane with the clock in the
     * middle, marking where a later stretch of the conversation begins. It is
     * inserted between turns that are more than five minutes apart, which is
     * the gap at which the transcript stops reading as one sitting.
     */
    data class Gap(val id: String, val label: String) : Item() { override val key = "gap.$id" }
    /*
     * One tool call, the way the desktop's step list draws it: a verb that
     * says where the call is, and what it was about (`title`). The phone used
     * to print `· read completed`, which told the reader nothing.
     */
    data class Tool(
        val uid: String,
        val name: String,
        val status: String,
        val output: String,
        val title: String = "",
        /**
         * What a `present_files` call handed over: its `metadata.files`, as
         * `{path, name, size}` entries.
         *
         * The desktop draws these as cards under the reply
         * (`DeliveredFilesCard.vue`); without them the phone showed the phrase
         * 「展示文件」 and nothing else, so a model that wrote a document and
         * presented it left the reader with no way to open what it wrote.
         */
        val delivered: List<DeliveredFile> = emptyList(),
        /**
         * The part this row was built from, kept because two cards need to read
         * it again: the file it wrote (`editedOf`) and what it presented. The
         * row already carries the words it shows; this is for the details a row
         * does not have room for.
         */
        val raw: JSONObject = JSONObject(),
    ) : Item() { override val key = "tool.$uid" }
    /*
     * A permission request, carried whole: the card decides what to show from
     * the request itself (its command or subject, whether it carries a diff,
     * whether it is a delete that must be asked every time), the way the
     * desktop's PermissionDialog does. Passing a pre-flattened string lost the
     * diff and the forced flag.
     */
    data class Perm(val requestId: String, val request: JSONObject, val queueTotal: Int = 1, val queuePosition: Int = 1) : Item() {
        override val key = "perm.$requestId"
    }
    data class Quest(val requestId: String, val request: JSONObject) : Item() { override val key = "quest.$requestId" }
    /*
     * A failure, keyed by the message it belongs to.
     *
     * It used to be keyed by a hash of the text, and two turns that failed the
     * same way produced the same key - which LazyColumn refuses, crashing the
     * app on open whenever a conversation held the same error twice. A counter
     * keeps `session.error` (which has no message of its own) unique as well.
     */
    data class Err(val text: String, val uid: String = "e${nextErrId()}") : Item() {
        override val key = "err.$uid"
    }
}

/**
 * 追求目標: the goal a conversation is being judged against, as `session.goal`
 * stores it (`SessionGoal` minus what no reader on a phone needs).
 */
data class GoalInfo(
    val condition: String,
    val startedAt: Long,
    val attempts: Int = 1,
    /** Set once the judge has answered: met, or out of reach / out of tries. */
    val doneStatus: String? = null,
    val doneReason: String = "",
    val doneAt: Long = 0L,
)

data class SessionRow(
    val id: String,
    val title: String,
    val running: Boolean,
    val updated: Long,
    val directory: String = "",
    val model: String = "",
    val agent: String = "build",
    val effort: String = "none",
    /** 追求目標: the switch is on, so the next message sent becomes the goal. */
    val goalMode: Boolean = false,
    val goal: GoalInfo? = null,
    /** Where the model will reach for files: ask / auto / full, as `session.access` names them. */
    val access: String = "full",
    /** Filed away: off the list, still readable, recoverable from 已归档对话. */
    val archived: Boolean = false,
)

/**
 * The three levels a conversation may run at, and which one it is at.
 *
 * A conversation's own level is only half the answer: one that never set a
 * level follows the app's default, which `shared/access.ts` derives from the
 * permission map (`accessLevel` = auto, or nothing left asking = full). Reading
 * only the session's field made every conversation without one look like
 * "全部允许", which is a claim the desktop never makes.
 */
private fun accessOf(row: SessionRow?, config: JSONObject?): String {
    row?.access?.takeIf { it in setOf("ask", "auto", "full") }?.let { own ->
        // Its own full access lapses once full access is not allowed.
        if (own != "full" || config?.optBoolean("allowFullAccess") != false) return own
    }
    if (config == null) return "full"
    if (config.optString("accessLevel") == "auto") return "auto"
    val map = config.optJSONObject("permissions")
    val asking = listOf("read", "edit", "glob", "grep", "list", "bash", "webfetch", "outside", "mcp").any { map?.optString(it) == "ask" }
    if (map == null || asking) return "ask"
    return if (config.optString("accessLevel") == "full" && !config.optBoolean("allowFullAccess", true)) "ask" else "full"
}

/**
 * A pty's output, minus the sequences a Text cannot obey.
 *
 * CSI (`ESC [ … letter`), OSC (`ESC ] … BEL`, which is how every shell sets its
 * window title), and the two-byte escapes in between. Carriage returns go too,
 * but a `\r` that is rewriting a line - a progress bar - is what a terminal
 * would fold onto itself; keeping only what follows the last `\r` on a line
 * gives the same visible result for the one shape this pane shows.
 */
private fun stripAnsi(raw: String): String {
    val csi = Regex("\u001B\\[[0-9;?]*[ -/]*[@-~]")
    val osc = Regex("\u001B\\][^\u0007\u001B]*(\u0007|\u001B\\\\)")
    val other = Regex("\u001B[@-Z\\\\-_]")
    return raw.replace(osc, "").replace(csi, "").replace(other, "")
        .lineSequence()
        .joinToString("\n") { line -> if ('\r' in line) line.substringAfterLast('\r') else line }
}

/**
 * One `SessionInfo` as a list row.
 *
 * `session.list` and `session.updated` carry the same object, and the phone read
 * the fields twice in two places - which is how the goal and the access level
 * ended up on the server but never on a row. One reader, so a field added here
 * reaches both.
 */
private fun rowOf(s: JSONObject, running: Boolean): SessionRow {
    val goal = s.optJSONObject("goal")?.let { g ->
        val condition = g.optString("condition")
        if (condition.isBlank()) null else {
            val done = g.optJSONObject("done")
            GoalInfo(
                condition = condition,
                startedAt = g.optLong("startedAt", 0L),
                attempts = g.optInt("attempts", 1),
                doneStatus = done?.optString("status"),
                doneReason = done?.optString("reason").orEmpty(),
                doneAt = done?.optLong("at", 0L) ?: 0L,
            )
        }
    }
    return SessionRow(
        id = s.optString("id"),
        title = s.optString("title", s.optString("id")),
        running = running,
        updated = s.optLong("updated", 0),
        directory = s.optString("directory", ""),
        model = s.optJSONObject("model")?.optString("model", "") ?: "",
        agent = s.optString("agent", "build"),
        effort = s.optString("effort", "none"),
        goalMode = s.optBoolean("goalMode", false),
        goal = goal,
        access = s.optString("access", ""),
        archived = s.optBoolean("archived", false),
    )
}

class RemoteClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var ws: okhttp3.WebSocket? = null
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    var onFrame: (JSONObject) -> Unit = {}
    var onState: (Boolean) -> Unit = {}

    // Responses are matched to their request by id; anyone waiting registers
    // here before sending. A concurrent map because onMessage runs on OkHttp
    // threads while the registration happens on the main thread.
    private val waiters = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.CompletableDeferred<JSONObject>>()

    /**
     * Registers a waiter for one reply.
     *
     * The entry is removed when the reply arrives - and, crucially, when it
     * never does. A request that timed out used to leave its waiter in the map
     * for the life of the process: every stalled read, every reply that came
     * back after the screen had moved on, one more entry. On a socket that drops
     * as often as this one does, that is a slow leak of whole JSON frames'
     * worth of deferred state.
     *
     * `forget` is what the caller's `finally` runs, so the cleanup does not
     * depend on the continuations remembering to do it.
     */
    fun awaitResponse(id: String): kotlinx.coroutines.CompletableDeferred<JSONObject> {
        val deferred = kotlinx.coroutines.CompletableDeferred<JSONObject>()
        waiters[id] = deferred
        return deferred
    }

    /** Drops a waiter whose reply will never come. Safe on an already-answered id. */
    fun forgetResponse(id: String) {
        waiters.remove(id)
    }

    fun connect(url: String, token: String) {
        val request = Request.Builder()
            .url(url)
            .header("Sec-WebSocket-Protocol", "mcode, mcode.remote.$token")
            .build()
        ws = http.newWebSocket(request, object : okhttp3.WebSocketListener() {
            override fun onOpen(webSocket: okhttp3.WebSocket, response: okhttp3.Response) {
                println("[remote] ws open")
                onState(true)
            }
            override fun onClosed(webSocket: okhttp3.WebSocket, code: Int, reason: String) {
                println("[remote] ws closed")
                onState(false)
            }
            override fun onFailure(webSocket: okhttp3.WebSocket, t: Throwable, response: okhttp3.Response?) {
                println("[remote] ws failure: $t")
                onState(false)
            }
            override fun onMessage(webSocket: okhttp3.WebSocket, text: String) {
                try {
                    val frame = JSONObject(text)
                    waiters.remove(frame.optString("id"))?.complete(frame)
                    /*
                     * Every frame is applied on the main thread. This ran on
                     * OkHttp's reader thread, so a burst of deltas and the
                     * composition were writing the same lists from two threads
                     * - which is the other half of the crash above.
                     */
                    main.post { onFrame(frame) }
                } catch (e: Exception) {
                    println("[remote] frame error: $e")
                }
            }
        })
    }

    fun send(text: String) {
        ws?.send(text)
    }

    fun close() {
        ws?.close(1000, "bye")
        ws = null
    }
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

class MainActivity : ComponentActivity() {
    companion object {
        /** The window's width class, recomputed on fold and split-screen moves. */
        private val widthSize = mutableStateOf(WindowWidthSizeClass.Compact)

        /** Single-operator defaults; overridden by what the connect screen saves. */
        const val DEFAULT_URL = "ws://192.168.10.156:7900"
        const val DEFAULT_TOKEN = "mcode-fold-2026"
        const val PREFS = "mcode-remote"
        const val OPERATOR = "Wyatt"
    }

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Draw behind the system bars like Claude does: the page's own color
        // reaches the status bar and the gesture area, so no black strips.
        enableEdgeToEdge()
        // The keep-alive umbrella: an ongoing quiet notification that keeps the
        // process out of the kill-first bucket while a session is expected to
        // keep running. Android 13+ gates its visibility behind a permission.
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 2026)
        }
        androidx.core.content.ContextCompat.startForegroundService(
            this, android.content.Intent(this, KeepAliveService::class.java),
        )
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val savedUrl = prefs.getString("url", DEFAULT_URL) ?: DEFAULT_URL
        val savedToken = prefs.getString("token", DEFAULT_TOKEN) ?: DEFAULT_TOKEN
        val autoUrl = intent.getStringExtra("connectUrl") ?: savedUrl
        val autoToken = intent.getStringExtra("connectToken") ?: savedToken
        val lastSession = prefs.getString("session", null)
        // Recomputed on fold/unfold instead of recreating the activity, so the
        // WebSocket and the open conversation survive the transition.
        widthSize.value = computeWidthClass()
        setContent {
            MCodeTheme {
                App(widthSize.value, autoUrl, autoToken, lastSession, onRemember = { id ->
                    prefs.edit().putString("session", id).apply()
                }) { u, t ->
                    prefs.edit().putString("url", u).putString("token", t).apply()
                }
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        widthSize.value = computeWidthClass()
    }

    /**
     * The width class off the display's real metrics. The activity's own
     * configuration stays stale for a self-handled change, and the fold's two
     * panels report different natural orientations - the window metrics are
     * the only source that is right in both cases.
     */
    private fun computeWidthClass(): WindowWidthSizeClass {
        val metrics = androidx.window.layout.WindowMetricsCalculator.getOrCreate()
            .computeMaximumWindowMetrics(this)
        val widthDp = (metrics.bounds.width() / resources.displayMetrics.density).toInt()
        return widthClassOf(widthDp)
    }

    /** Material 3's breakpoints, straight off a window width in dp. */
    private fun widthClassOf(widthDp: Int): WindowWidthSizeClass = when {
        widthDp >= 840 -> WindowWidthSizeClass.Expanded
        widthDp >= 600 -> WindowWidthSizeClass.Medium
        else -> WindowWidthSizeClass.Compact
    }
}

@Composable
fun MCodeTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    /*
     * The clock and battery have to follow the page: white glyphs on the cream
     * page were invisible, which is what edge-to-edge left behind when the
     * system bar appearance was never set.
     */
    val view = androidx.compose.ui.platform.LocalView.current
    SideEffect {
        val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
        androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
    val bg = if (dark) DarkBg else Cream
    val surface = if (dark) DarkSurface else CreamSurface
    val text = if (dark) DarkText else Ink
    val muted = if (dark) DarkMuted else InkMuted
    val pill = if (dark) DarkPill else CreamPill
    val line = if (dark) DarkLine else CreamLine
    val scheme = if (dark) {
        darkColorScheme(background = bg, surface = DarkSurface, onBackground = DarkText, onSurface = DarkText, primary = Ember, secondary = DarkPill, onSecondary = DarkText, surfaceVariant = DarkPill, onSurfaceVariant = DarkMuted, outline = DarkLine, surfaceTint = Color.Transparent)
    } else {
        lightColorScheme(background = bg, surface = CreamSurface, onBackground = Ink, onSurface = Ink, primary = Ember, secondary = CreamPill, onSecondary = Ink, surfaceVariant = CreamPill, onSurfaceVariant = InkMuted, outline = CreamLine, surfaceTint = Color.Transparent)
    }
    CompositionLocalProvider(
        LocalBg provides bg,
        LocalSurface provides surface,
        LocalText provides text,
        LocalMuted provides muted,
        LocalPill provides pill,
        // In dark the reader's turn sits *under* the page (13,13,13 against
        // 21,21,21), not on paper: a white patch measured earlier turned out to
        // be the text-selection highlight from a long press.
        LocalBubble provides (if (dark) Color(0xFF0D0D0D) else CreamPill),
        LocalBubbleText provides (if (dark) DarkText else Ink),
        LocalLine provides line,
        LocalField provides (if (dark) DarkField else CreamSurface),
        LocalFieldLine provides (if (dark) DarkFieldLine else CreamPill),
    ) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/* MCode's own mark, straight from the desktop build. */
/**
 * Claude's asterisk, for the empty pane at phone width.
 *
 * Measured off its own screenshot rather than guessed, twice: the first
 * attempt drew four lines through the centre (they met, and it read as a
 * starfish), the second alternated long and short (wrong - it does not).
 * A radial profile of the real mark, 112 px across at 450 dpi:
 *
 *   12 spokes, 30 degrees apart, reaching 0.95-1.12 of the radius between
 *   them - equal length, within the error of reading a 112 px PNG;
 *   starting at 0.05 of the radius, so they meet at the centre;
 *   about 4-5 degrees wide, round-capped.
 */
@Composable
fun SparkMark(modifier: Modifier = Modifier, tint: Color = Ember) {
    androidx.compose.foundation.Canvas(modifier) {
        val cx = size.width / 2f
        val cy = size.height / 2f
        val outer = size.minDimension / 2f
        /*
         * Fitted, not eyeballed: sweeping stroke width and inner radius against
         * the real mark's ink coverage (42% of the 112 px box) lands on 0.16 of
         * the radius and a start at the centre. A 0.05 start left a hole in the
         * middle that the original does not have.
         */
        val stroke = outer * 0.16f
        for (i in 0 until 12) {
            // The first spoke sits a little off vertical in the original.
            val angle = Math.toRadians((i * 30.0) + 12.0)
            val r0 = 0f
            val r1 = outer
            drawLine(
                tint,
                androidx.compose.ui.geometry.Offset(cx + (Math.cos(angle) * r0).toFloat(), cy + (Math.sin(angle) * r0).toFloat()),
                androidx.compose.ui.geometry.Offset(cx + (Math.cos(angle) * r1).toFloat(), cy + (Math.sin(angle) * r1).toFloat()),
                strokeWidth = stroke,
                cap = androidx.compose.ui.graphics.StrokeCap.Round,
            )
        }
    }
}

@Composable
fun MCodeMark(modifier: Modifier = Modifier) {
    androidx.compose.foundation.Image(
        painter = androidx.compose.ui.res.painterResource(R.drawable.mcode_mark),
        contentDescription = "MCode",
        modifier = modifier,
    )
}

fun relTime(updated: Long): String {
    if (updated <= 0) return ""
    val diff = System.currentTimeMillis() - updated
    val minutes = diff / 60000
    return when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "$minutes 分钟前"
        minutes < 60 * 24 -> "${minutes / 60} 小时前"
        minutes < 60 * 48 -> "昨天"
        else -> {
            val cal = java.util.Calendar.getInstance().apply { timeInMillis = updated }
            "${cal.get(java.util.Calendar.MONTH) + 1}月${cal.get(java.util.Calendar.DAY_OF_MONTH)}日"
        }
    }
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun App(widthSize: WindowWidthSizeClass, autoUrl: String, autoToken: String, lastSession: String? = null, onRemember: (String?) -> Unit = {}, onSave: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val client = remember { RemoteClient() }

    var connected by remember { mutableStateOf(false) }
    var connectedOnce by remember { mutableStateOf(autoUrl.isNotBlank() && autoToken.isNotBlank()) }
    var url by remember { mutableStateOf(autoUrl) }
    var token by remember { mutableStateOf(autoToken) }
    var showConnect by remember { mutableStateOf(false) }
    /** The pending backoff before a reconnect, or null when connected. */
    var retryDelay by remember { mutableStateOf<Long?>(null) }
    /** The last refusal the server sent, for a screen to report. */
    var lastError by remember { mutableStateOf<String?>(null) }
    /**
     * When the list was last read, so a turn that finished while the socket was
     * down can be told apart from one that was already there.
     */
    var lastSeenAt by remember { mutableStateOf(0L) }
    /**
     * The newest `updated` this screen had already shown for each conversation.
     *
     * The reconnect pass compares against `lastSeenAt`, which only moves when the
     * list is re-read - so a conversation the reader had OPENED and read during
     * a later stretch was still compared against the older figure and came back
     * marked unread. Comparing against what was on screen for that conversation
     * answers the actual question: is this newer than what the reader saw?
     */
    val seenUpdated = remember { java.util.HashMap<String, Long>() }
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    fun openDrawer() = scope.launch { drawerState.open() }
    fun closeDrawer() = scope.launch { drawerState.close() }
    var search by remember { mutableStateOf("") }
    /*
     * What the transcripts say, not just what the titles say.
     *
     * The desktop's overlay searches three sources at once - titles, message
     * bodies (`search.messages`) and the files conversations wrote - and the
     * phone's box only filtered titles, so a word inside a reply could not be
     * found from the list at all.
     */
    var foundHits by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var searchingBodies by remember { mutableStateOf(false) }
    /**
     * Whether the list's search field is showing.
     *
     * Claude's header carries a magnifier, not a box: the field is a mode the
     * reader enters, and it covers nothing until then. The drawer's magnifier
     * sets this too, which is what that glyph was always meant to do.
     */
    var searching by remember { mutableStateOf(false) }
    /**
     * The split between the two panes, as a fraction of the window.
     *
     * Claude's is 0.2641 - 900 of 3408 - and its divider can be dragged, so the
     * number is the reader's once they touch it. Kept in memory rather than
     * prefs for now: the default is the measured value, and a drag survives
     * every rebuild of this screen because it is hoisted here.
     */
    /*
     * 0.2714, not the 0.2641 a `weight` reading gives: 925 of 3408 px is where
     * Claude's left pane actually ends, and the 900 this used to use was the
     * divider's own left edge measured as if the divider took no space. With a
     * real 24dp handle between the panes the difference showed as the list
     * being a millimetre narrow and the conversation starting early.
     */
    var leftFraction by remember { mutableStateOf(0.2714f) }
    /** The window's width in pixels, which is what a drag's fraction divides by. */
    var paneWidthPx by remember { mutableStateOf(0) }
    /**
     * What the left column is showing, as Claude's pane switches between them:
     * the conversation list, the projects, and the scheduled tasks.
     */
    var leftMode by remember { mutableStateOf(LeftMode.Sessions) }
    var projectAdding by remember { mutableStateOf(false) }
    /** Bumped to re-read the project list after one is added. */
    var refreshCommandsTick by remember { mutableStateOf(0) }
    /** `config.projects` - every folder the app treats as a project, newest first. */
    val projects = remember { mutableStateListOf<String>() }
    /**
     * `config.projectNames` - the display name a project was given, by folder.
     * A project without one is its folder's own last segment, which is what
     * `projectName()` in `lib/project.ts` falls back to.
     */
    val projectNames = remember { mutableStateMapOf<String, String>() }
    /** `config.projectUsed` - when each project was last picked, for the ordering. */
    val projectUsed = remember { mutableStateMapOf<String, Long>() }
    /**
     * 作品: the files the app has produced, from `artifact.list`.
     *
     * Claude's drawer opens with 项目 / Code / Artifacts / 定时任务, and this
     * app had no third one at all - a whole page of the product's own output
     * was unreachable from a tablet. `artifact.list` answers with one entry per
     * conversation that produced something, each with its files.
     */
    val artifacts = remember { mutableStateListOf<JSONObject>() }
    var artifactsLoading by remember { mutableStateOf(false) }
    /** Which facet the artifacts page is filtered to: "" / doc / app / other. */
    var artCategory by remember { mutableStateOf("") }
    var artFacets by remember { mutableStateOf<JSONObject?>(null) }
    var artBuilding by remember { mutableStateOf(false) }
    var artQuery by remember { mutableStateOf("") }
    var artifactsFailed by remember { mutableStateOf(false) }
    /** Bumped by the page's 重试, which re-reads the first page. */
    var refreshArtifacts by remember { mutableStateOf(0) }
    var runningOnly by remember { mutableStateOf(false) }
    var privacy by remember { mutableStateOf(false) }
    var projectFilter by remember { mutableStateOf<String?>(null) }
    /**
     * 技能与插件: the desktop's plugins page, which lists the folder's skills
     * and its MCP servers side by side and lets either be switched off.
     */
    val pluginServers = remember { mutableStateListOf<JSONObject>() }
    val pluginSkills = remember { mutableStateListOf<JSONObject>() }
    var pluginsLoading by remember { mutableStateOf(false) }
    var pluginsFailed by remember { mutableStateOf(false) }
    var refreshPlugins by remember { mutableStateOf(0) }
    /**
     * 模型服务: the providers and their keys.
     *
     * This is the one screen a phone needs that no other reaches: a turn whose
     * key has expired fails with a sentence and nothing else, and the only way
     * to fix it was the desktop. `provider.auth` writes the key where the
     * desktop's own dialog does - through the credentials store, never into
     * `config.json`, which is the mistake that made a pasted key look saved and
     * never work.
     */
    var showProviders by remember { mutableStateOf(false) }
    var keyTarget by remember { mutableStateOf<JSONObject?>(null) }
    /** The plugins page's two halves, as `mcp.list` and `skill.list` returned them. */
    var pluginError by remember { mutableStateOf("") }
    /** Which switch is mid-write: "mcp:name" or "skill:name". One at a time, as the desktop holds it. */
    /**
     * The scheduled tasks the server pushes as `automation.tasks`.
     *
     * The page used to say "MCode has no scheduled tasks yet" as a permanent
     * sentence, which was a guess: the server has had them all along and simply
     * broadcasts them to whoever is listening.
     */
    val automations = remember { mutableStateListOf<Triple<String, String, Long>>() }
    var sheetTarget by remember { mutableStateOf<SessionRow?>(null) }
    var renameTarget by remember { mutableStateOf<SessionRow?>(null) }
    /** Bumped when the reader taps the conversation's title; the timeline obeys. */
    var toTopTicks by remember { mutableStateOf(0) }
    /*
     * Find in the conversation. The desktop opens its bar on Ctrl+F and paints
     * the matches through the browser's highlight registry (`lib/find.ts`);
     * the phone had no way to look inside a long transcript at all. Closed by
     * default, and holding its own needle so the conversation list's filter
     * and this one never share a word.
     */
    var findOpen by remember { mutableStateOf(false) }
    var findQuery by remember { mutableStateOf("") }
    var findStep by remember { mutableStateOf(0) }
    /**
     * The slash commands this folder offers.
     *
     * The desktop reads them from `command.list` and opens a filtered menu when
     * the box starts with `/`; the phone had no way to reach them at all, so a
     * command that exists everywhere else on the product was untypable here.
     */
    val commands = remember { mutableStateListOf<Pair<String, String>>() }
    /**
     * Prompts waiting for the running turn to end, oldest first.
     *
     * The desktop keeps `SessionInfo.queued` and shows it above the composer,
     * each line withdrawable or promotable. The phone sent a queued message and
     * then lost sight of it: nothing said it had been queued, and there was no
     * way to take it back short of resetting the turn.
     */
    val queuedPrompts = remember { mutableStateListOf<Pair<String, String>>() }
    /**
     * Whether the session lets the app choose the model ("Smart" on the
     * desktop's model pill). It changes what the pill says, and it is the
     * default way a conversation is run, so the phone should say it too.
     */
    var smartMode by remember { mutableStateOf(false) }
    /**
     * 追求目標: the switch in the plus menu. It is the conversation's setting,
     * not the phone's, so it is read back from the row and written through
     * `session.goalMode` - a message sent while it is on becomes the goal.
     */
    var goalMode by remember { mutableStateOf(false) }
    /** The goal sheet being edited (its condition), or null. */
    var goalEdit by remember { mutableStateOf<String?>(null) }
    var deleteTarget by remember { mutableStateOf<SessionRow?>(null) }
    var voiceText by remember { mutableStateOf<String?>(null) }
    /** The turn whose long-press sheet is open (复制 / 从此处分支). */
    var messageTarget by remember { mutableStateOf<Item.Msg?>(null) }
    /** The question being rewritten in 编辑并重发. */
    var editTarget by remember { mutableStateOf<Item.Msg?>(null) }
    var modelPicker by remember { mutableStateOf(false) }
    var providers by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    /**
     * The application's own settings, which the access level falls back to: a
     * conversation without a level of its own runs at the map's default, and
     * the map is only readable from `config.get`.
     */
    var appConfig by remember { mutableStateOf<JSONObject?>(null) }
    /**
     * The project browser.
     *
     * The desktop keeps a whole right-hand rail - files, changes, review,
     * subagents, terminal, version history - and a tablet has the room for at
     * least the first of them. `root` is the folder being listed, `sub` the
     * path inside it, and `path` the stack of crumbs walked down.
     */
    var showFiles by remember { mutableStateOf(false) }
    /**
     * The terminal drawer.
     *
     * The desktop keeps a pty in a drawer at the foot of the conversation; the
     * gateway hands a phone the same `shell.open`/`shell.input` requests with
     * the owner "remote", so the phone can carry one of its own. Its output
     * streams as `shell.data` - which the gateway holds back from the frame
     * buffer, so the phone reads it live rather than on resume.
     */
    var showTerminal by remember { mutableStateOf(false) }
    /** The pty this drawer opened; kept while the sheet is up so its history survives a close. */
    var terminalId by remember { mutableStateOf<String?>(null) }
    var terminalText by remember { mutableStateOf("") }
    var terminalInput by remember { mutableStateOf("") }
    var fileStack by remember { mutableStateOf(listOf("")) }
    val fileEntries = remember { mutableStateListOf<Pair<String, Boolean>>() }
    var filePreview by remember { mutableStateOf<Pair<String, String>?>(null) }
    /**
     * A video opened from the artifacts page, as its name and the local copy
     * the bytes were written to. The desktop plays straight off its disk
     * (`file.read` answers `video: true` with no data and the files tab hands
     * the path to its local server); across the gateway the bytes are the only
     * way, so they arrive base64 and land in the cache before playing.
     */
    var videoPreview by remember { mutableStateOf<Pair<String, java.io.File>?>(null) }
    /**
     * A PDF opened from the artifacts page: its name and the local copy.
     *
     * The desktop streams a PDF through its local preview server for the ranges
     * pdf.js asks for; across the gateway there is no such server, so the file
     * arrives whole and is drawn with Android's own `PdfRenderer`. Same shape as
     * the video above - bytes on the wire, a temp file here.
     */
    var pdfPreview by remember { mutableStateOf<Pair<String, java.io.File>?>(null) }
    /** An Office document, already turned into one HTML page by the gateway. */
    var officePreview by remember { mutableStateOf<Triple<String, String, String>?>(null) }
    /**
     * The changes rail: which files a turn touched, and the patch for the one
     * being read. The desktop keeps this beside the conversation all the time;
     * on a phone it belongs in a sheet reached from the header.
     */
    var showChanges by remember { mutableStateOf(false) }
    val changedFiles = remember { mutableStateListOf<String>() }
    var changePatch by remember { mutableStateOf<Pair<String, String>?>(null) }
    var changeBranch by remember { mutableStateOf("") }
    /** Branches offered under the change list; the desktop's branch chip does the same from the home screen. */
    val branches = remember { mutableStateListOf<String>() }
    var showBranches by remember { mutableStateOf(false) }
    /** The commit card's message and its in-flight flag. */
    var commitMessage by remember { mutableStateOf("") }
    var commitBusy by remember { mutableStateOf(false) }
    /** The changes panel's two "there is nothing to show" cases, which are not the same as "nothing changed". */
    var changesNoRepo by remember { mutableStateOf(false) }
    var changesNoGit by remember { mutableStateOf(false) }
    /** Parked permission requests per session, replayed from session.list. */
    val pendingPerms = remember { java.util.concurrent.ConcurrentHashMap<String, MutableList<JSONObject>>() }
    /**
     * Conversations whose turn finished while the reader was elsewhere.
     *
     * The desktop keeps this as `unseen` in its store (`Sidebar.vue`'s
     * `statusOf`): a row that finished out of sight wears a blue dot until it
     * is opened. The phone had no such state at all - one static dot on every
     * row, grey or blue - so a reply that arrived while another conversation
     * was on screen could only be found by scrolling and guessing.
     */
    val unseen = remember { mutableStateListOf<String>() }
    /**
     * A conversation whose history is still on its way.
     *
     * `stream.loadingConvo` - 「正在加载对话…」 - is what the desktop shows over
     * an empty thread while `session.get` is out. The phone drew the empty
     * state instead, so opening a conversation with turns in it showed the
     * greeting for as long as the read took, as if the conversation were new.
     */
    var loadingThread by remember { mutableStateOf(false) }
    /** Parked question cards per session, replayed from question.list. */
    val pendingQuestions = remember { java.util.concurrent.ConcurrentHashMap<String, MutableList<JSONObject>>() }
    /** Bumped whenever the parked maps change, so the replay effect re-runs. */
    var replayTick by remember { mutableStateOf(0) }
    val context = androidx.compose.ui.platform.LocalContext.current

    /**
     * What was typed but not sent, per conversation.
     *
     * The desktop keeps a draft for each conversation and puts it back on
     * return, and so across a restart (`lib/composer-drafts.ts`). The phone kept
     * one string for the whole box, which meant a half-written message to one
     * conversation was carried into the next one - and lost entirely if the app
     * was closed. Held here rather than in the composer because the composer is
     * remounted as the session changes, and written to the same preferences the
     * last session id already uses.
     */
    val drafts = remember { mutableStateMapOf<String, String>() }
    val draftStore = context.getSharedPreferences("mcode-remote-drafts", android.content.Context.MODE_PRIVATE)
    LaunchedEffect(Unit) {
        for ((key, value) in draftStore.all) {
            if (key.startsWith("draft.") && value is String && value.isNotEmpty()) drafts[key.removePrefix("draft.")] = value
        }
    }

    /** Pending attachments: {"path","mime","data"} ready for session.prompt. */
    val attachments = remember { mutableStateListOf<JSONObject>() }
    /*
     * The desktop's row is 添加照片和文件 and its picker takes any file: a
     * text one travels as its text, everything else as base64 - by the
     * extension table in `shared/attachment-kind.ts`, which is the table the
     * message builder reads on the other side. This picker was ImageOnly, so a
     * `.md` or a `.csv` on the phone could not be attached at all.
     */
    /** A display name for a picked document, as the picker's uri itself does not carry one. */
    fun queryName(uri: android.net.Uri): String? {
        if (uri.scheme == "content") {
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val at = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (at >= 0 && cursor.moveToFirst()) return cursor.getString(at)
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        var attached = 0
        for (uri in uris) try {
            val name = queryName(uri) ?: continue
            val mime = context.contentResolver.getType(uri) ?: ""
            val textual = mime.startsWith("text/") || textualName(name)
            val data = if (textual) {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: continue
            } else {
                context.contentResolver.openInputStream(uri)?.use { android.util.Base64.encodeToString(it.readBytes(), android.util.Base64.NO_WRAP) } ?: continue
            }
            attachments.add(JSONObject().put("path", name).put("mime", mime.ifBlank { if (textual) "text/plain" else "application/octet-stream" }).put("data", data))
            attached += 1
        } catch (_: Exception) {}
        if (attached > 0) Toast.makeText(context, "已附上 $attached 个文件", Toast.LENGTH_SHORT).show()
    }
    fun pickImages() {
        runCatching { filePicker.launch(arrayOf("*/*")) }
            .onFailure { Toast.makeText(context, "无法打开文件选择器", Toast.LENGTH_SHORT).show() }
    }

    val sessions = remember { mutableStateListOf<SessionRow>() }
    val items = remember { mutableStateListOf<Item>() }
    val messageIndex = remember { mutableStateMapOf<String, Int>() }

    /**
     * Where a message's row is, without trusting the cached position.
     *
     * `messageIndex` is written when a row is appended, and rows are inserted
     * between them afterwards - a wave divider before a later turn, a tool row
     * under one, an error card at the end. Every insertion shifts everything
     * below it, so the stored position can name a different message. Reading
     * through this resolver keeps a streamed delta from being written into
     * another turn's bubble; the map stays as the fast path.
     */
    fun rowOfMessage(id: String): Int {
        val known = messageIndex[id]
        if (known != null && known in items.indices) {
            val row = items[known]
            if (row is Item.Msg && row.id == id) return known
        }
        val found = items.indexOfFirst { it is Item.Msg && it.id == id }
        if (found >= 0) messageIndex[id] = found
        return found
    }
    var currentSession by remember { mutableStateOf<String?>(null) }
    var cursor by remember { mutableStateOf(0L) }
    /** Counts selections, so a history reply for an abandoned one is dropped. */
    var selectSeq by remember { mutableStateOf(0) }
    /** Each streamed part's kind, from the `message.part.updated` before its deltas. */
    val partKinds = remember { java.util.HashMap<String, String>() }
    /**
     * The words of each text part, by part id.
     *
     * A reply can be several text parts - the model writes, calls a tool, then
     * writes again - and the desktop joins them with a blank line
     * (`replyText` in MessageStream.vue). The phone overwrote the bubble with
     * whichever part arrived last, so a reply that used a tool showed only the
     * second half of itself.
     */
    val partTexts = remember { java.util.HashMap<String, String>() }
    /** When each part was first seen, so a rebuilt reply keeps its order. */
    val partOrder = remember { java.util.HashMap<String, Int>() }
    var partSeq = 0
    /**
     * How much thinking each assistant turn produced, by message id.
     *
     * The desktop treats a turn that thought but never answered as a FAILURE
     * rather than an empty reply (`thinkOnly` in MessageStream.vue): there was
     * output, just not the part that counts, and MiMo writes it up as something
     * to retry. The phone drops reasoning parts on purpose, so the only way to
     * know this happened is to remember that some arrived.
     */
    val reasoningSeen = remember { java.util.HashMap<String, Int>() }
    /**
     * What the last turn spent, for the composer's context ring.
     *
     * The desktop reads this off the transcript (`session-context.ts`) and draws
     * a ring left of the model pill; the phone kept no usage at all, so the one
     * figure that tells a reader their window is filling had no home here. The
     * newest assistant message's `usage` is the number the desktop's reader ends
     * on as well.
     */
    var contextUsed by remember { mutableStateOf(0) }
    var contextLimit by remember { mutableStateOf(0) }

    /**
     * Marks a conversation as working, or done.
     *
     * The row list is the single source of truth for that (the composer and the
     * timeline both read it), so a change is written back into the row rather
     * than kept beside it.
     */
    fun setRunning(sessionID: String, running: Boolean) {
        val at = sessions.indexOfFirst { it.id == sessionID }
        if (at < 0) return
        if (sessions[at].running == running) return
        sessions[at] = sessions[at].copy(running = running)
        // A turn that ends while its own conversation is not on screen leaves
        // the row unread, which is the state the blue dot reports.
        if (!running && sessionID != currentSession) {
            if (sessionID !in unseen) unseen.add(sessionID)
        }
    }

    fun frame(json: JSONObject) = client.send(json.toString())

    fun request(request: JSONObject, id: String) {
        frame(JSONObject().put("kind", "request").put("id", id).put("request", request))
    }
    fun request(request: JSONObject): String {
        val id = "r" + System.nanoTime()
        request(request, id)
        return id
    }

    /** One RPC round trip: register the waiter, send, await the reply. */
    suspend fun rpc(req: JSONObject, timeoutMs: Long = 20_000): JSONObject {
        val id = "rpc" + System.nanoTime()
        val deferred = client.awaitResponse(id)
        request(req, id)
        // Transcription runs a whisper pass on the PC and takes longer than a
        // protocol question does; the caller names how long it may wait.
        val frame = try {
            kotlinx.coroutines.withTimeout(timeoutMs) { deferred.await() }
        } finally {
            // The reply may still arrive later; the entry must not sit there
            // holding a deferred nobody will ever complete.
            client.forgetResponse(id)
        }
        /*
         * A refusal is recorded whether or not the caller looks.
         *
         * The protocol answers `{ok: false, error}` for anything the server will
         * not do - a session that is gone, a path that is not a project, a
         * provider without a key. Every one of the thirty-odd callers read
         * `data` and took `null` for "nothing to show", so a refusal arrived as
         * an empty list or an idle screen with no word about what happened.
         *
         * It is NOT thrown here: most callers run inside `scope.launch` with no
         * catch, and a thrown exception in those would take the app down -
         * trading a silent failure for a crash. `lastError` is what a screen
         * shows, and `rpcOrThrow` is for the callers that want the failure
         * inline.
         */
        if (frame.has("ok") && !frame.optBoolean("ok")) {
            lastError = frame.optString("error").ifBlank { "请求失败" }
        } else {
            lastError = null
        }
        return frame
    }

    /**
     * One round trip that refuses to pretend.
     *
     * For the callers that act on what came back - they get the failure instead
     * of an empty `data`, so they can say what went wrong rather than doing
     * nothing.
     */
    suspend fun rpcOrThrow(req: JSONObject, timeoutMs: Long = 20_000): JSONObject {
        val frame = rpc(req, timeoutMs)
        if (frame.has("ok") && !frame.optBoolean("ok")) {
            throw IllegalStateException(frame.optString("error").ifBlank { "请求失败" })
        }
        return frame
    }

    /*
     * Bodies are asked for a moment after typing stops, so a keystroke already
     * superseded does not spend a round trip, and the answer is written only if
     * the needle it was asked for is still the needle in the box.
     */
    LaunchedEffect(search) {
        val needle = search.trim()
        if (needle.isBlank()) {
            foundHits = emptyList()
            searchingBodies = false
            return@LaunchedEffect
        }
        searchingBodies = true
        kotlinx.coroutines.delay(180)
        if (search.trim() != needle) return@LaunchedEffect
        val reply = runCatching {
            rpc(JSONObject().put("type", "search.messages").put("query", needle).put("limit", 30))
        }.getOrNull()
        if (search.trim() != needle) return@LaunchedEffect
        foundHits = reply?.optJSONObject("data")?.optJSONArray("hits")?.let { arr ->
            (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        } ?: emptyList()
        searchingBodies = false
    }

    var recording by remember { mutableStateOf<android.media.MediaRecorder?>(null) }
    var recordFile by remember { mutableStateOf<java.io.File?>(null) }
    var voiceBusy by remember { mutableStateOf(false) }

    fun finishVoice() {
        val recorder = recording ?: return
        recording = null
        val file = recordFile
        recordFile = null
        runCatching { recorder.stop() }
        recorder.release()
        if (file == null || !file.exists() || file.length() < 1200) {
            // A tap that caught nothing is a miss, not a failure.
            file?.delete()
            voiceBusy = false
            Toast.makeText(context, "没听清，请再说一次", Toast.LENGTH_SHORT).show()
            return
        }
        voiceBusy = true
        scope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                file.delete()
                val reply = rpc(
                    JSONObject()
                        .put("type", "voice.transcribe")
                        .put("audio", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                        .put("mime", "audio/mp4")
                        .put("mode", "fast")
                        .put("language", "zh-CN")
                        .put("sessionID", currentSession),
                    90_000,
                )
                val heard = reply.optJSONObject("data")?.optString("text").orEmpty()
                if (heard.isNotBlank()) voiceText = heard
                else Toast.makeText(context, "没听清，请再说一次", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(context, "语音识别失败：${e.message?.take(60) ?: "未知错误"}", Toast.LENGTH_LONG).show()
            } finally {
                voiceBusy = false
            }
        }
    }

    /*
     * First tap asks for the microphone; the grant comes back here and the
     * recording starts, so the ask and the recorder stay in one place.
     */
    fun beginRecording() {
        val file = java.io.File(context.cacheDir, "voice-${System.currentTimeMillis()}.m4a")
        // API 31 deprecated the no-arg constructor: the context-bound one is
        // what a recorder should be built from now, and the old one still has
        // to be used below it.
        val recorder = if (android.os.Build.VERSION.SDK_INT >= 31) {
            android.media.MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            android.media.MediaRecorder()
        }
        try {
            recorder.setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(android.media.MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioSamplingRate(16_000)
            recorder.setAudioEncodingBitRate(48_000)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            recorder.start()
            recording = recorder
            recordFile = file
            Toast.makeText(context, "录音中，再点一下结束", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            runCatching { recorder.release() }
            file.delete()
            Toast.makeText(context, "无法开始录音：${e.message?.take(40) ?: ""}", Toast.LENGTH_LONG).show()
        }
    }

    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) beginRecording()
        else Toast.makeText(context, "需要麦克风才能语音输入", Toast.LENGTH_LONG).show()
    }

    fun startVoice() {
        if (voiceBusy) return
        if (recording != null) { finishVoice(); return }  // second tap stops
        if (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
            return
        }
        beginRecording()
    }

    /* Split from startVoice so the permission launcher, declared below it, can
       start the recording without referring back: the two halves never form a
       cycle in the local-function namespace. */


    /**
     * Drops an answered request from the parked list.
     *
     * `pendingPerms` is what a conversation re-opened later replays as its
     * 待确认 cards. Nothing ever removed an entry once it was answered, so every
     * permission the reader had already granted came back as still waiting the
     * next time that conversation was opened - and the row's 待确认 pill with
     * it.
     */
    fun clearPerm(requestId: String) {
        /*
         * The card in the transcript goes with the entry here.
         *
         * Usually `permission.resolved` / `question.replied` removes it - but the
         * server's own `respond` returns early when the request is no longer
         * pending (`if (!pending) return` in permission.ts) and publishes
         * nothing in that case, which happens the moment the desk answered the
         * same request first or a reconnect replays a stale card. The reply the
         * phone sent still succeeded, so nothing else would ever take the card
         * off the screen.
         */
        items.removeAll { (it is Item.Perm && it.requestId == requestId) || (it is Item.Quest && it.requestId == requestId) }
        if (items.none { it is Item.Perm }) KeepAliveService.instance?.restoreKeepAlive()
        val keys = pendingPerms.keys.toList()
        for (key in keys) {
            pendingPerms[key]?.removeAll { it.optString("id") == requestId }
            if (pendingPerms[key]?.isEmpty() == true) pendingPerms.remove(key)
        }
        // Explicitly, rather than through `entries.removeAll`: a concurrent
        // map's entry view does not promise the removeIf semantics this needs.
        for (key in pendingQuestions.keys.toList()) {
            val list = pendingQuestions[key] ?: continue
            list.removeAll { it.optString("id") == requestId }
            if (list.isEmpty()) pendingQuestions.remove(key)
        }
    }

    fun respondPerm(requestId: String, response: String) {
        /*
         * The card is cleared only once the server has taken the answer.
         *
         * It used to be cleared first, then the request sent - so a reply that
         * never got through (a dropped socket, a turn that had already been
         * cancelled) took the card off the screen while the tool stayed
         * blocked on a permission nobody had answered: nothing on the page, and
         * nothing in the transcript either, because the model was still waiting.
         */
        scope.launch {
            val ok = runCatching {
                rpc(JSONObject().put("type", "permission.respond").put("requestID", requestId).put("response", response))
            }.isSuccess
            if (ok) clearPerm(requestId)
            else Toast.makeText(context, "答复没有送达，请重试", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * A refusal with a reason: the server hands the sentence to the model, so
     * it knows what to do differently rather than just that it was stopped.
     */
    fun respondPermReason(requestId: String, reason: String) {
        val req = JSONObject().put("type", "permission.respond").put("requestID", requestId).put("response", "reject")
        if (reason.isNotBlank()) req.put("reason", reason)
        // Same rule as `respondPerm`: the card goes only after the server took it.
        scope.launch {
            val ok = runCatching { rpc(req) }.isSuccess
            if (ok) clearPerm(requestId)
            else Toast.makeText(context, "答复没有送达，请重试", Toast.LENGTH_LONG).show()
        }
    }

    fun loadProviders() {
        scope.launch {
            try {
                val reply = rpc(JSONObject().put("type", "provider.list"))
                providers = reply.optJSONObject("data")?.optJSONArray("providers")?.let { arr ->
                    (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                } ?: emptyList()
            } catch (e: Exception) {
                println("[remote] provider.list failed: $e")
            }
        }
    }


    fun answerQuestion(requestId: String, answer: List<String>) {
        // Same reason as `clearPerm`: an answered question is no longer parked,
        // and a card that comes back on the next open would be a question the
        // model has already been told the answer to.
        scope.launch {
            val ok = runCatching {
                rpc(JSONObject().put("type", "question.reply").put("requestID", requestId).put("answers", org.json.JSONArray().put(org.json.JSONArray(answer))))
            }.isSuccess
            // An answer that never arrived left the question card gone and the
            // model still waiting for it - the same silence either way.
            if (ok) clearPerm(requestId)
            else Toast.makeText(context, "回答没有送达，请重试", Toast.LENGTH_LONG).show()
        }
    }

    fun loadPendingQuestions() {
        scope.launch {
            try {
                val reply = rpc(JSONObject().put("type", "question.list"))
                val arr = reply.optJSONObject("data")?.optJSONArray("questions") ?: return@launch

                for (i in 0 until arr.length()) {
                    val r = arr.optJSONObject(i) ?: continue
                    pendingQuestions.getOrPut(r.optString("sessionID")) { mutableListOf() }.add(r)
                }
                replayTick++

            } catch (e: Exception) {
                println("[remote] question.list failed: $e")
            }
        }
    }

    // Whichever of the replay data and the selected session lands first, the
    // cards land on the timeline once both are in; a light poll because the
    // parked maps live outside the snapshot system.
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(500)
            val sid = currentSession ?: continue
            /*
             * Only the questions and permissions are looked at, and the set is
             * built from a transcript that is usually much longer than they
             * are. Two empty maps is the common case - a running turn with
             * nothing parked - and it used to rebuild a set of every row's key
             * twice a second for nothing.
             */
            val parked = pendingQuestions[sid].orEmpty() + pendingPerms[sid].orEmpty()
            if (parked.isEmpty()) continue
            val known = items.map { it.key }.toSet()
            for (r in pendingQuestions[sid].orEmpty()) {
                val card = Item.Quest(r.optString("id"), r)
                if (card.key !in known) items.add(card)
            }
            for (p in pendingPerms[sid].orEmpty()) {
                val card = Item.Perm(p.optString("id"), p, pendingPerms[p.optString("sessionID")].orEmpty().size)
                if (card.key !in known) items.add(card)
            }
        }
    }

    fun upsertMessage(sessionID: String, message: JSONObject) {
        if (sessionID != currentSession) return
        val id = message.optString("id")
        val role = message.optString("role", "assistant")
        val parts = message.optJSONArray("parts")
        // Stored transcripts carry the text flat on the message; live events
        // carry it in parts. Accept both.
        val text = StringBuilder(message.optString("text", ""))
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val part = parts.optJSONObject(i) ?: continue
                when (part.optString("type")) {
                    "text" -> {
                        // Blank line between parts, as the live rebuild and the
                        // desktop both join them - a single newline made two
                        // paragraphs read as one run-on.
                        text.append(part.optString("text")).append("\n\n")
                        /*
                         * The same store the live path writes, so a reply read
                         * from disk can go on being rebuilt when its next part
                         * streams in. Without this a conversation opened from
                         * history and then continued had its earlier text wiped
                         * the moment a new part arrived: the rebuild only knew
                         * about parts it had seen itself.
                         */
                        val pid = part.optString("id")
                        if (pid.isNotBlank()) {
                            partTexts[pid] = part.optString("text")
                            partKinds[pid] = "text"
                            if (pid !in partOrder) partOrder[pid] = partSeq++
                        }
                    }
                    /*
                     * Counted but not drawn: a stored turn whose only part is
                     * reasoning is the desktop's `thinkOnly`, and it has to be
                     * recognised from the history as well as from the stream -
                     * this loop is the one a conversation read from disk goes
                     * through, and it used to drop reasoning entirely.
                     */
                    "reasoning" -> {
                        val so = part.optString("text")
                        if (so.isNotBlank()) reasoningSeen[id] = (reasoningSeen[id] ?: 0) + so.length
                    }
                }
            }
        }
        val known = rowOfMessage(id).takeIf { it >= 0 }
        /*
         * A turn is under way while its reply is unfinished, which is the same
         * rule the desktop uses: the phone had no notion of a running turn at
         * all, so the working line and the stop button never appeared.
         */
        if (role == "assistant" && id.isNotBlank()) {
            val finished = message.optString("finish").isNotBlank() || message.optJSONObject("time")?.optLong("completed", 0L)?.let { it > 0L } == true
            setRunning(sessionID, !finished)
            /*
             * MiMo's figure leaves reasoning out: the prompt, the cache reads
             * and writes, and the output. A message without usage (a stored
             * one from before this build, or a reply still streaming) leaves
             * the last number alone rather than resetting it to zero.
             */
            message.optJSONObject("usage")?.let { u ->
                val used = u.optInt("input", 0) + u.optInt("cacheRead", 0) + u.optInt("cacheWrite", 0) + u.optInt("output", 0)
                if (used > 0) contextUsed = used
            }
        }
        // A picture the user sent is part of the question: the desktop draws it
        // above the bubble and lets it be opened, so the phone keeps the data
        // URLs and does the same rather than showing an empty turn.
        val images = message.optJSONArray("attachments")?.let { arr ->
            (0 until arr.length()).mapNotNull { index ->
                val att = arr.optJSONObject(index) ?: return@mapNotNull null
                val mime = att.optString("mime", "")
                val data = att.optString("data", "")
                if (!mime.startsWith("image/") || data.isBlank()) null else "data:$mime;base64,$data"
            }
        } ?: emptyList()
        val sentFiles = message.optJSONArray("attachments")?.let { arr ->
            (0 until arr.length()).mapNotNull { index ->
                val att = arr.optJSONObject(index) ?: return@mapNotNull null
                if (att.optString("mime", "").startsWith("image/")) null else att.optString("path", "").ifBlank { null }
            }
        } ?: emptyList()
        if (known != null && known in items.indices) {
            val existing = items[known]
            if (existing is Item.Msg) {
                /*
                 * Whole-message updates and deltas both feed the same block, and
                 * an update that was assembled before the last delta landed is
                 * shorter than what is already on screen. Taking the longer of
                 * the two stops a streamed reply from flicking backwards, and a
                 * finished message still wins because it is the whole text.
                 */
                val whole = text.toString().trim()
                val settled = message.optString("finish").isNotBlank() || (message.optJSONObject("time")?.optLong("completed", 0L) ?: 0L) > 0L
                val next = if (settled || whole.length >= existing.text.length) whole else existing.text
                items[known] = existing.copy(
                    text = next,
                    images = images,
                    files = sentFiles,
                    steered = message.optBoolean("steered"),
                    finish = message.optString("finish", existing.finish),
                    // A whole-message update can arrive before the reasoning
                    // part was counted; taking the larger keeps what is known.
                    thought = maxOf(existing.thought, reasoningSeen[id] ?: 0),
                )
            }
        } else {
            val body = text.toString().trim()
            /*
             * An assistant turn with no words still has to become a row when it
             * ended for a reason worth saying. This gate used to drop every one
             * of them, so a turn that broke, was stopped, or thought without
             * answering left NOTHING on the page - the notes that explain those
             * cases had no row to attach to, which is why the first two
             * attempts at this fix appeared to do nothing at all.
             */
            val worthARow = body.isNotEmpty() || role == "user" || images.isNotEmpty() ||
                (role == "assistant" && (message.optString("finish").let { it.isNotBlank() && it != "end_turn" } || (reasoningSeen[id] ?: 0) > 0))
            if (worthARow) {
                /*
                 * A later sitting gets the wave divider: Claude puts one where
                 * the conversation resumes after a gap, with the clock in the
                 * middle. Five minutes is where a transcript stops reading as
                 * one stretch; a shorter pause needs no mark.
                 */
                val at = message.optJSONObject("time")?.optLong("created", 0L) ?: 0L
                if (role == "user" && at > 0L) {
                    val previous = items.lastOrNull { it is Item.Msg } as? Item.Msg
                    if (previous != null && previous.at > 0L && at - previous.at > 5 * 60_000L) {
                        val label = android.text.format.DateFormat.format("HH:mm", at).toString()
                        items.add(Item.Gap("gap.${previous.id}.$id", label))
                    }
                }
                /*
                 * A question made only of a file had no words at all, and this
                 * block used to print a lone ellipsis for it - the file itself
                 * was dropped when the attachments were read. The desktop draws
                 * a sheet icon and the file name above the bubble (`sent-tile
                 * file`), so the phone does the same and lets it be tapped.
                 */
                /*
                 * The ellipsis is for a READER's turn that carried only a file
                 * - their question had no words, and an empty bubble said
                 * nothing. An assistant turn must never get it: the mark made
                 * `text` non-blank for a reply that said nothing at all, which
                 * hid both the "only thought, no answer" note and the plain
                 * empty-reply case behind a stray 「…」.
                 */
                val fallback = if (role != "assistant" && images.isEmpty() && sentFiles.isEmpty()) "…" else ""
                items.add(
                    Item.Msg(
                        id, role, body.ifEmpty { fallback }, images, at,
                        message.optBoolean("steered"), sentFiles,
                        finish = message.optString("finish"),
                        thought = reasoningSeen[id] ?: 0,
                        reverted = message.optBoolean("reverted"),
                    ),
                )
                messageIndex[id] = items.size - 1
            }
        }
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val part = parts.optJSONObject(i) ?: continue
                if (part.optString("type") != "tool") continue
                // One row per call, keyed by the call's own id: a streamed turn
                // sends the same part many times as it moves pending -> running
                // -> completed, and appending each would stack a tower of rows.
                val callID = part.optString("callID").ifEmpty { part.optString("id") }
                val uid = if (callID.isNotBlank()) callID else java.util.UUID.randomUUID().toString()
                val status = part.optJSONObject("state")?.optString("status", "")?.ifEmpty { null } ?: part.optString("status", "")
                val output = part.optString("output").ifEmpty { part.optJSONObject("state")?.optString("output", "") ?: "" }
                val row = Item.Tool(
                    uid,
                    part.optString("name", "tool"),
                    status,
                    output.replace(Regex("<[^>]+>"), "").lineSequence().firstOrNull()?.take(90) ?: "",
                    toolTitleOf(part),
                    deliveredOf(part),
                    part,
                )
                val at = items.indexOfFirst { it is Item.Tool && it.uid == uid }
                if (at >= 0) items[at] = row else items.add(row)
            }
        }
        /*
         * A turn that broke has no text at all, so it used to arrive as an
         * empty message and be dropped: the question stayed on screen with
         * nothing after it and no sign that anything had gone wrong. The
         * desktop draws an error card for exactly this.
         */
        val failure = message.optString("error").ifEmpty {
            if (message.optString("finish") == "error" || message.optString("finish") == "max_tokens") "这次回复没有完成" else ""
        }
        if (failure.isNotBlank()) {
            val key = "err.$id"
            val place = items.indexOfFirst { it.key == key }
            if (place >= 0) items[place] = Item.Err(failure, id) else items.add(Item.Err(failure, id))
        }
    }

    /**
     * A slice of a reply's text, appended to the message it belongs to.
     *
     * The reply streams as deltas that name only a part id, so the part's kind
     * has to be known first: a reasoning part arrives just before its first
     * delta and says it is `reasoning`. The phone used to fold every delta into
     * the message text, which printed the model's thinking as if it had said it.
     */
    /** `map[key] ?: 0` for an Int-valued HashMap. */
    fun once(value: Int?): Int = value ?: 0

    fun appendDelta(sessionID: String, messageID: String, partID: String, text: String) {
        if (sessionID != currentSession || messageID.isBlank() || text.isEmpty()) return
        if (partKinds[partID] == "reasoning") {
            // Counted, not shown: a turn whose only output is thinking is
            // written up as a failure rather than as an empty reply.
            reasoningSeen[messageID] = once(reasoningSeen[messageID]) + text.length
            return
        }
        val known = rowOfMessage(messageID).takeIf { it >= 0 }
        if (known != null) {
            val existing = items[known]
            if (existing is Item.Msg) items[known] = existing.copy(text = existing.text + text)
            return
        }
        items.add(Item.Msg(messageID, "assistant", text))
        messageIndex[messageID] = items.size - 1
        setRunning(sessionID, true)
    }

    fun upsertPart(sessionID: String, messageID: String, part: JSONObject) {
        if (sessionID != currentSession) return
        // Remembered before the deltas that name it arrive, so a reasoning part
        // is never mistaken for prose.
        val partID = part.optString("id")
        if (partID.isNotBlank()) {
            partKinds[partID] = part.optString("type")
            if (partID !in partOrder) partOrder[partID] = partSeq++
        }
        if (part.optString("type") == "reasoning") {
            val so = part.optString("text")
            if (so.isNotBlank()) reasoningSeen[messageID] = once(reasoningSeen[messageID]) + so.length
        }
        val known = rowOfMessage(messageID).takeIf { it >= 0 } ?: return
        val existing = items[known]
        if (existing !is Item.Msg) return
        when (part.optString("type")) {
            "text" -> {
                if (partID.isNotBlank()) partTexts[partID] = part.optString("text")
                // Rebuilt from every text part the message has shown so far, in
                // the order they were first seen, joined the way the desktop
                // joins them.
                val joined = partTexts.keys
                    .filter { partKinds[it] == "text" }
                    .sortedBy { partOrder[it] ?: Int.MAX_VALUE }
                    .mapNotNull { partTexts[it] }
                    .filter { it.isNotBlank() }
                    .joinToString("\n\n")
                if (joined.isNotBlank()) items[known] = existing.copy(text = joined)
            }
            "tool" -> {
                // Same rule as a whole message: a call streams in many times,
                // so the row is found by its call id and replaced in place.
                val callID = part.optString("callID").ifEmpty { part.optString("id") }
                val uid = if (callID.isNotBlank()) callID else java.util.UUID.randomUUID().toString()
                val status = part.optJSONObject("state")?.optString("status", "")?.ifEmpty { null } ?: part.optString("status", "")
                val output = part.optString("output").ifEmpty { part.optJSONObject("state")?.optString("output", "") ?: "" }
                val row = Item.Tool(
                    uid,
                    part.optString("name", "tool"),
                    status,
                    output.replace(Regex("<[^>]+>"), "").lineSequence().firstOrNull()?.take(90) ?: "",
                    toolTitleOf(part),
                    deliveredOf(part),
                    part,
                )
                val at = items.indexOfFirst { it is Item.Tool && it.uid == uid }
                if (at >= 0) items[at] = row else items.add(row)
            }
        }
    }

    fun select(id: String?) {
        currentSession = id
        if (id != null) {
            unseen.remove(id)
            sessions.find { it.id == id }?.let { seenUpdated[id] = it.updated }
        }
        // What the reader was last in stays open across restarts: Claude
        // reopens the conversation you left, not whichever conversation
        // happened to move most recently.
        onRemember(id)
        // Bumped before the request goes out: a history that comes back after
        // the reader has moved on belongs to a conversation that is no longer
        // on screen, and writing it in would put one thread's turns under
        // another thread's title.
        selectSeq++
        val seq = selectSeq
        items.clear()
        messageIndex.clear()
        partKinds.clear()
        partTexts.clear()
        partOrder.clear()
        partSeq = 0
        reasoningSeen.clear()
        loadingThread = id != null
        if (id == null) return
        // Parked permissions ride along: a turn can be sitting on an answer
        // while the phone reconnected, and the card must not vanish with the
        // in-memory timeline (the desktop replays these the same way).
        for (p in pendingPerms[id].orEmpty()) items.add(Item.Perm(p.optString("id"), p, pendingPerms[p.optString("sessionID")].orEmpty().size))
        for (r in pendingQuestions[id].orEmpty()) items.add(Item.Quest(r.optString("id"), r))
        frame(JSONObject().put("kind", "request").put("id", "w${System.nanoTime()}")
            .put("request", JSONObject().put("type", "session.watch").put("sessionIDs", org.json.JSONArray().put(id))))
        // History first; the live stream rides on top of it.
        scope.launch {
            val ticket = "h${System.nanoTime()}"
            val deferred = client.awaitResponse(ticket)
            request(JSONObject().put("type", "session.get").put("sessionID", id), ticket)
            /*
             * The loading line comes down however this read ends. It used to be
             * cleared only after a reply arrived, so a `session.get` that timed
             * out or was refused left 「正在加载对话…」 on screen for good - the
             * conversation never opened again without a restart.
             */
            val res = try {
                runCatching { deferred.await() }.getOrNull()
            } finally {
                client.forgetResponse(ticket)
                if (seq == selectSeq) loadingThread = false
            }
            if (res == null || seq != selectSeq) return@launch
            queuedPrompts.clear()
            val info = res.optJSONObject("data")?.optJSONObject("session")
            smartMode = info?.optBoolean("smart") ?: false
            // 追求目標 and the access level are the conversation's own, and
            // `session.get` is where the freshest copy arrives: `session.list`
            // was read before this selection and may name another session.
            info?.let { row ->
                goalMode = row.optBoolean("goalMode", false)
                val fresh = rowOf(row, sessions.find { it.id == id }?.running == true)
                val at = sessions.indexOfFirst { it.id == id }
                if (at >= 0) sessions[at] = fresh else sessions.add(fresh)
            }
            val q = res.optJSONObject("data")?.optJSONObject("session")?.optJSONArray("queued")
            if (q != null) {
                for (k in 0 until q.length()) {
                    val item = q.optJSONObject(k) ?: continue
                    queuedPrompts.add(item.optString("id") to item.optString("text"))
                }
            }
            val messages = res.optJSONObject("data")?.optJSONArray("messages") ?: return@launch
            items.clear()
            messageIndex.clear()
            for (i in 0 until messages.length()) upsertMessage(id, messages.optJSONObject(i) ?: continue)
            // Parked cards go after the transcript, not before it: a turn waiting
            // on an answer is the newest thing that happened, and putting the
            // card above the history scrolled it out of sight.
            for (p in pendingPerms[id].orEmpty()) items.add(Item.Perm(p.optString("id"), p, pendingPerms[p.optString("sessionID")].orEmpty().size))
            for (r in pendingQuestions[id].orEmpty()) items.add(Item.Quest(r.optString("id"), r))
        }
    }

    /**
     * Starts a conversation and opens it.
     *
     * `session.create` answers with the new session, and nothing else would
     * select it: the event stream only carries `session.updated`, which adds
     * the row without moving the pane. Claude switches to the new
     * conversation the moment it exists, so this does too.
     */
    fun newSession(directory: String = "") {
        scope.launch {
            try {
                val ask = JSONObject().put("type", "session.create").put("title", "来自手机")
                if (directory.isNotBlank()) ask.put("directory", directory)
                val reply = rpc(ask)
                val sid = reply.optJSONObject("data")?.optJSONObject("session")?.optString("id").orEmpty()
                if (sid.isNotBlank()) select(sid)
                else Toast.makeText(context, "新建会话失败", Toast.LENGTH_LONG).show()
            } catch (e: Exception) {
                // A new conversation that does not appear looks like a dead
                // button; the reason has to be said out loud.
                Toast.makeText(context, "新建会话失败：${e.message?.take(60) ?: "未知错误"}", Toast.LENGTH_LONG).show()
            }
        }
    }


    fun handle(f: JSONObject) {
        when (f.optString("kind")) {
            "remote.welcome" -> {
                cursor = f.optLong("eventId", 0)
                frame(JSONObject().put("kind", "remote.resume").put("cursor", cursor))
                request(JSONObject().put("type", "session.list"), "list${System.nanoTime()}")
                loadPendingQuestions()
                // The pill names the model, and the name lives in the provider
                // list; without this it would show the raw id until the reader
                // happened to open the picker.
                loadProviders()
            }
            "response" -> {
                val id = f.optString("id")
                if (id.startsWith("list")) {
                    sessions.clear()
                    val data = f.optJSONObject("data") ?: return
                    val running = data.optJSONArray("running")?.let { arr -> (0 until arr.length()).map { arr.optString(it) }.toSet() } ?: emptySet()
                    val list = data.optJSONArray("sessions") ?: return
                    for (i in 0 until list.length()) {
                        val s = list.optJSONObject(i) ?: continue
                        val sid = s.optString("id")
                        sessions.add(rowOf(s, sid in running))
                    }
                    sessions.sortByDescending { it.updated }
                    // Replay what is parked: sessions waiting on a permission
                    // keep the tool hanging until someone answers.
                    pendingPerms.clear()
                    data.optJSONArray("permissions")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val p = arr.optJSONObject(i) ?: continue
                            pendingPerms.getOrPut(p.optString("sessionID")) { mutableListOf() }.add(p)
                        }
                        replayTick++
                    }
                    /*
                     * The open conversation may have been deleted while the
                     * socket was down. This list is the authority now, and a
                     * `currentSession` naming a row that is no longer in it
                     * left the pane showing a conversation nothing could load -
                     * no title, no transcript, and a send that failed.
                     */
                    val gone = currentSession?.takeIf { live -> sessions.none { it.id == live } }
                    if (gone != null) {
                        unseen.remove(gone)
                        pendingPerms.remove(gone)
                        pendingQuestions.remove(gone)
                        seenUpdated.remove(gone)
                        currentSession = null
                        items.clear()
                        messageIndex.clear()
                        loadingThread = false
                        selectSeq++
                    }
                    /*
                     * A turn that ran to completion while the link was down is
                     * unread now. `unseen` was never rebuilt from this list, so
                     * a reply that arrived in that window left no dot at all -
                     * the reader had no way to know it had happened.
                     */
                    // Only from the second read on: on the first there is no
                    // "while you were away" - every conversation would be
                    // marked unread, including ones the reader had just left.
                    if (lastSeenAt > 0) {
                        for (row in sessions) {
                            val seen = seenUpdated[row.id] ?: lastSeenAt
                            if (!row.running && row.id != currentSession && row.id != gone && row.updated > seen) {
                                if (row.id !in unseen) unseen.add(row.id)
                            }
                        }
                    }
                    for (row in sessions) {
                        val seen = seenUpdated[row.id] ?: 0L
                        // The open conversation counts as read as its row moves:
                        // the reader is looking at it, so a reconnect must not
                        // arrive and mark it unread.
                        if (row.updated > seen || row.id == currentSession) seenUpdated[row.id] = row.updated
                    }
                    lastSeenAt = System.currentTimeMillis()
                    if (currentSession == null && sessions.isNotEmpty()) {
                        // The conversation the reader left, if it is still
                        // there; otherwise the most recent one.
                        val remembered = lastSession?.takeIf { wanted -> sessions.any { it.id == wanted } }
                        select(remembered ?: sessions.first().id)
                    } else currentSession?.let { sid ->
                        val known = items.map { it.key }.toSet()
                        for (p in pendingPerms[sid].orEmpty()) {
                            val card = Item.Perm(p.optString("id"), p, pendingPerms[p.optString("sessionID")].orEmpty().size)
                            if (card.key !in known) items.add(card)
                        }
                    }
                }
            }
            "remote.event" -> {
                cursor = maxOf(cursor, f.optLong("eventId", 0))
                val event = f.optJSONObject("event") ?: return
                when (event.optString("type")) {
                    "session.updated" -> {
                        val s = event.optJSONObject("session") ?: return
                        val sid = s.optString("id")
                        // A running flag is the list's, not the session's, so it
                        // is carried across rather than read from this event.
                        val next = rowOf(s, sessions.find { it.id == sid }?.running == true)
                        val at = sessions.indexOfFirst { it.id == sid }
                        if (at >= 0) sessions[at] = next else sessions.add(next)
                        sessions.sortByDescending { it.updated }
                    }
                    /*
                     * The turn is over: the working line has to go and the
                     * round button has to become send again. Without this the
                     * phone sat showing a working line for ever.
                     */
                    "session.idle" -> {
                        setRunning(event.optString("sessionID"), false)
                    }
                    "automation.tasks" -> {
                        automations.clear()
                        val arr = event.optJSONArray("tasks") ?: return
                        for (i in 0 until arr.length()) {
                            val t = arr.optJSONObject(i) ?: continue
                            automations.add(
                                Triple(
                                    t.optString("id"),
                                    t.optString("title"),
                                    t.optLong("nextAt", 0L),
                                ),
                            )
                        }
                    }
                    "session.deleted" -> {
                        val gone = event.optString("sessionID")
                        sessions.removeAll { it.id == gone }
                        // A row that is gone cannot be unread, and the set is
                        // held for the life of the screen: without this every
                        // deleted conversation's id stayed in it for good.
                        unseen.remove(gone)
                        pendingPerms.remove(gone)
                        pendingQuestions.remove(gone)
                        // A map keyed by conversation outlives the conversation
                        // unless it is told, and this one is read on every
                        // reconnect pass.
                        seenUpdated.remove(gone)
                        if (currentSession == gone) {
                            currentSession = null
                            items.clear()
                            messageIndex.clear()
                            // The read this conversation had under way will
                            // never land; it must not leave the spinner up.
                            loadingThread = false
                            selectSeq++
                        }
                    }
                    "message.updated" -> upsertMessage(event.optString("sessionID"), event.optJSONObject("message") ?: return)
                    /*
                     * The reply arrives as deltas, not as whole parts: text
                     * streams through `message.delta` and only a tool part is
                     * re-sent complete when its status changes. Without this the
                     * phone showed no words at all while a turn was running and
                     * then jumped straight to the finished message.
                     */
                    "message.delta" -> appendDelta(
                        event.optString("sessionID"),
                        event.optString("messageID"),
                        event.optString("partID"),
                        event.optString("text"),
                    )
                    "message.part.updated" -> upsertPart(event.optString("sessionID"), event.optString("messageID"), event.optJSONObject("part") ?: return)
                    "permission.requested" -> {
                        val r = event.optJSONObject("request") ?: return
                        pendingPerms.getOrPut(r.optString("sessionID")) { mutableListOf() }.add(r)
                        items.add(Item.Perm(r.optString("id"), r, pendingPerms[r.optString("sessionID")].orEmpty().size))
                        // Surface the card on the lock screen too: the ongoing
                        // notification flips to "MCode 请求批准" until answered.
                        KeepAliveService.instance?.showPermission(r.optString("title", ""))
                    }
                    "permission.resolved" -> {
                        val rid = event.optString("requestID")
                        for (list in pendingPerms.values) list.removeAll { it.optString("id") == rid }
                        items.removeAll { it is Item.Perm && it.requestId == rid }
                        if (items.none { it is Item.Perm }) KeepAliveService.instance?.restoreKeepAlive()
                    }
                    "question.asked" -> {
                        val r = event.optJSONObject("request") ?: return
                        pendingQuestions.getOrPut(r.optString("sessionID")) { mutableListOf() }.add(r)
                        items.add(Item.Quest(r.optString("id"), r))
                    }
                    "question.replied" -> {
                        val rid = event.optString("requestID")
                        for (list in pendingQuestions.values) list.removeAll { it.optString("id") == rid }
                        items.removeAll { it is Item.Quest && it.requestId == rid }
                    }
                    "question.rejected" -> {
                        val rid = event.optString("requestID")
                        for (list in pendingQuestions.values) list.removeAll { it.optString("id") == rid }
                        items.removeAll { it is Item.Quest && it.requestId == rid }
                    }
                    "session.error" -> items.add(Item.Err(event.optString("error")))
                    /*
                     * The desktop changed a setting - the permission map among
                     * them - and the phone's access pill reads that map, so it
                     * is kept current rather than read once at connect.
                     */
                    "config.updated" -> appConfig = event.optJSONObject("config")
                    /*
                     * The terminal drawer's own pty, if one is open. Kept to the
                     * last 8000 characters: a chatty command can print megabytes
                     * and a Text of that size is a frame that never draws.
                     */
                    "shell.data" -> {
                        if (event.optString("shellID") == terminalId) {
                            terminalText = (terminalText + event.optString("data")).takeLast(8000)
                        }
                    }
                    "shell.exit" -> {
                        if (event.optString("shellID") == terminalId) {
                            terminalText += "\n[进程已结束]\n"
                            terminalId = null
                        }
                    }
                }
            }
        }
    }

    client.onState = { up ->
        connected = up
        if (up) {
            connectedOnce = true
            retryDelay = null
        } else if (connectedOnce) {
            /*
             * The socket dropped after it had been up.
             *
             * There was no reconnect at all: `onFailure` set `connected` false
             * and stopped, so one Wi-Fi hiccup or one gateway restart left the
             * app dead until the reader went into 连接设置 and pressed connect
             * by hand - with the list just sitting there empty, which looks
             * like an empty account rather than a lost link.
             *
             * It retries on a backoff, and the banner says so meanwhile.
             */
            /*
             * Set only when there is no wait pending. Every failed retry fires
             * `onFailure` again, and assigning unconditionally reset the wait
             * to one second each time - so the backoff never actually grew and
             * a gateway that stayed down was hammered once a second forever.
             */
            if (retryDelay == null) retryDelay = 1000L
        }
    }

    /*
     * The backoff: 1s, 2s, 4s, 8s, then every 15s. Long enough not to hammer a
     * gateway that is restarting, short enough that a reader who unlocked the
     * pad again finds the app already back.
     */
    /*
     * A loop, not one shot keyed on the delay.
     *
     * Keyed on `(connected, retryDelay)`, this ran once per distinct wait - and
     * once the wait had grown to its 15s cap it stopped changing, so the effect
     * was never re-launched and the retries simply stopped. A gateway that came
     * back after that cap never saw the app again until it was restarted.
     *
     * The loop keeps going while the screen is up and the socket is down;
     * `connected` flipping true is what ends a cycle's wait, and the effect is
     * re-keyed on `connected` so a fresh drop starts a fresh one.
     */
    LaunchedEffect(connected) {
        if (connected) {
            retryDelay = null
            return@LaunchedEffect
        }
        while (!connected && url.isNotBlank() && token.isNotBlank()) {
            val wait = retryDelay ?: 1000L
            kotlinx.coroutines.delay(wait)
            if (connected) break
            client.connect(url, token)
            retryDelay = minOf(wait * 2, 15_000L)
        }
    }
    client.onFrame = { f -> handle(f) }

    LaunchedEffect(Unit) {
        if (autoUrl.isNotBlank() && autoToken.isNotBlank()) client.connect(autoUrl, autoToken)
    }

    /*
     * The app's settings, for the one question a conversation's own fields
     * cannot answer: at what access level a conversation without a level of
     * its own runs. Read once when the socket comes up, and again whenever the
     * desktop writes the config.
     */
    LaunchedEffect(connected, refreshCommandsTick) {
        if (!connected) return@LaunchedEffect
        val read = runCatching { rpc(JSONObject().put("type", "config.get")) }.getOrNull()
            ?.optJSONObject("data")?.optJSONObject("config")
        appConfig = read
        // Claude's projects page lists `config.projects`, newest added first.
        projects.clear()
        read?.optJSONArray("projects")?.let { arr ->
            for (i in 0 until arr.length()) arr.optString(i).takeIf { it.isNotBlank() }?.let { projects.add(it) }
        }
        projectNames.clear()
        read?.optJSONObject("projectNames")?.let { obj ->
            for (key in obj.keys()) if (obj.optString(key).isNotBlank()) projectNames[key] = obj.optString(key)
        }
        projectUsed.clear()
        read?.optJSONObject("projectUsed")?.let { obj ->
            for (key in obj.keys()) projectUsed[key] = obj.optLong(key)
        }
    }

    if (!connectedOnce || showConnect) {
        ConnectScreen(url, token) { u, t ->
            showConnect = false
            url = u; token = t
            onSave(u, t)
            client.close()
            client.connect(u, t)
        }
        return
    }

    /*
     * The page's first read: `artifact.list` for the chosen facet, newest first.
     * A failed read is a state of its own - the desktop says 加载产物索引失败 and
     * offers 重试 rather than drawing an empty page, because an empty page and a
     * broken index look identical otherwise.
     */
    LaunchedEffect(leftMode, artCategory, refreshArtifacts) {
        if (leftMode != LeftMode.Artifacts) return@LaunchedEffect
        artifactsLoading = true
        artifactsFailed = false
        val ask = JSONObject().put("type", "artifact.list").put("limit", 50)
        if (artCategory.isNotEmpty()) ask.put("category", artCategory)
        val reply = runCatching { rpc(ask, 45_000) }.getOrNull()
        val data = reply?.optJSONObject("data")
        artifacts.clear()
        data?.optJSONArray("artifacts")?.let { list ->
            for (i in 0 until list.length()) list.optJSONObject(i)?.let { artifacts.add(it) }
        }
        // The facet counts cover files this page has not loaded, so they are the
        // server's, not a count of what is here.
        if (artCategory.isEmpty()) artFacets = data?.optJSONObject("facets")
        artBuilding = data?.optBoolean("building") ?: false
        artifactsFailed = data == null
        artifactsLoading = false
    }

    /**
     * Open one row of 作品.
     *
     * `artifact.list` names a file either project-relative or absolute, and
     * `file.read` refuses a `rel` that is not relative to its `root` - it
     * answers "outside: the path is not relative to its root". So an absolute
     * path is split at its own last separator and read against that directory,
     * which is the same file by a different pair of arguments.
     */
    fun openArtifact(root: String, rel: String) {
        scope.launch {
            val absolute = rel.length > 2 && rel[1] == ':' || rel.startsWith("/")
            val ask = if (absolute) {
                val cut = maxOf(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
                JSONObject().put("type", "file.read")
                    .put("root", if (cut > 0) rel.substring(0, cut) else root)
                    .put("rel", if (cut > 0) rel.substring(cut + 1) else rel)
            } else {
                JSONObject().put("type", "file.read").put("root", root).put("rel", rel)
            }
            /*
             * An Office document is not read here at all: the gateway turns it
             * into one HTML page, because the libraries that understand docx,
             * xlsx and pptx live there and a WebView here can only render what
             * it is given. `badgeOf` has given these files a badge for months
             * while opening one answered with an empty sheet.
             */
            val officeExt = rel.substringAfterLast('.', "").lowercase()
            if (officeExt in setOf("docx", "xlsx", "pptx")) {
                val name = rel.substringAfterLast('/').substringAfterLast('\\')
                val reply = runCatching {
                    rpc(
                        JSONObject().put("type", "office.render").put("root", root).put("rel", rel),
                        60_000,
                    )
                }.getOrNull()?.optJSONObject("data")
                val html = reply?.optString("html").orEmpty()
                if (html.isNotBlank()) {
                    officePreview = Triple(name, reply?.optString("kind").orEmpty().ifBlank { officeExt }, html)
                } else {
                    Toast.makeText(
                        context,
                        reply?.optString("error").orEmpty().ifBlank { "打不开这个文档" },
                        Toast.LENGTH_LONG,
                    ).show()
                }
                return@launch
            }
            ask.put("preview", true)
            // The desktop plays a video from its own disk and asks for no bytes;
            // this reader has no disk on the far side of the gateway, so it asks.
            // A text or picture preview ignores the flag.
            ask.put("withBytes", true)
            val r = runCatching { rpc(ask, 60_000) }.getOrNull()
            val payload = r?.optJSONObject("data")
            if (payload?.optBoolean("video") == true) {
                val name = rel.substringAfterLast('/').substringAfterLast('\\')
                val b64 = payload.optString("data")
                if (b64.isBlank()) {
                    // The 25 MB ceiling: the server says video but carries nothing.
                    Toast.makeText(context, "视频超过 25 MB，无法预览", Toast.LENGTH_SHORT).show()
                } else {
                    runCatching {
                        val dir = java.io.File(context.cacheDir, "video-preview").apply { mkdirs() }
                        val out = java.io.File(dir, name.replace(Regex("[^\\w.\\- ()]"), "_"))
                        out.outputStream().use { it.write(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)) }
                        videoPreview = name to out
                    }.onFailure { Toast.makeText(context, "视频没有取回来", Toast.LENGTH_SHORT).show() }
                }
                return@launch
            }
            /*
             * A PDF carries its bytes when asked, so it lands here the same way
             * a video does - except that it is drawn rather than played, and a
             * document's own renderer is the only thing that can do it.
             */
            if (payload?.optString("kind") == "pdf") {
                val name = rel.substringAfterLast('/').substringAfterLast('\\')
                val b64 = payload.optString("data")
                if (b64.isBlank()) {
                    Toast.makeText(context, "PDF 超过 25 MB，无法预览", Toast.LENGTH_SHORT).show()
                } else {
                    runCatching {
                        val dir = java.io.File(context.cacheDir, "pdf-preview").apply { mkdirs() }
                        val out = java.io.File(dir, name.replace(Regex("[^\\w.\\- ()]"), "_"))
                        out.outputStream().use { it.write(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)) }
                        pdfPreview = name to out
                    }.onFailure { Toast.makeText(context, "PDF 没有取回来", Toast.LENGTH_SHORT).show() }
                }
                return@launch
            }
            val body = payload?.optString("content").orEmpty()
            if (body.isNotBlank()) filePreview = rel.substringAfterLast('/').substringAfterLast('\\') to body
        }
    }

    /*
     * 撤销 on an edited-files card: take the turn's changes back out of the
     * files, then reload the conversation so both the files and the card's own
     * reverted form come from the server rather than from a guess here.
     *
     * The server refuses this while a turn is running or when the turn is no
     * longer in the conversation, and answers with what it could and could not
     * move - so the sentence is built from its counts, the way the desktop's
     * `revert()` words it.
     */
    fun revertTurn(messageIDs: List<String>) {
        val sid = currentSession ?: return
        scope.launch {
            val reply = runCatching {
                rpc(JSONObject().put("type", "session.revertTurn").put("sessionID", sid).put("messageIDs", org.json.JSONArray(messageIDs)), 120_000)
            }.getOrNull()
            val data = reply?.optJSONObject("data")
            if (data == null) {
                Toast.makeText(context, lastError ?: "撤销失败", Toast.LENGTH_LONG).show()
                return@launch
            }
            val restored = data.optInt("restored")
            val removed = data.optInt("removed")
            val failed = data.optInt("failed")
            val outside = data.optInt("outside")
            val done = restored + removed
            val said = when {
                done == 0 && outside > 0 -> "有 $outside 个文件在项目外，撤销未处理"
                done == 0 && failed > 0 -> "撤销失败：$failed 个文件未能撤销"
                done == 0 -> "撤销失败"
                else -> buildString {
                    append("已撤销 $done 个文件")
                    val extra = listOfNotNull(
                        if (failed > 0) "$failed 个文件未能撤销" else null,
                        if (outside > 0) "$outside 个文件在项目外" else null,
                    )
                    if (extra.isNotEmpty()) append("；").append(extra.joinToString("，"))
                }
            }
            Toast.makeText(context, said, Toast.LENGTH_LONG).show()
            // Both the files and the card's own reverted form come from the
            // server, so the conversation is read again rather than patched here.
            if (done > 0) select(sid)
        }
    }
    /*
     * The plugins page reads both lists together: `mcp.list` for the servers
     * and `skill.list` for the folder's skills. Neither is fatal on its own -
     * a folder with no skills is the ordinary case, and a server that will not
     * start is reported inside its own card rather than as a page failure.
     */
    LaunchedEffect(leftMode, refreshPlugins) {
        if (leftMode != LeftMode.Plugins) return@LaunchedEffect
        pluginsLoading = true
        pluginsFailed = false
        val dir = sessions.find { it.id == currentSession }?.directory.orEmpty()
        val mcp = runCatching { rpc(JSONObject().put("type", "mcp.list")) }.getOrNull()
        val sk = runCatching { rpc(JSONObject().put("type", "skill.list").put("directory", dir)) }.getOrNull()
        pluginServers.clear()
        mcp?.optJSONObject("data")?.optJSONArray("servers")?.let { arr ->
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { pluginServers.add(it) }
        }
        pluginSkills.clear()
        sk?.optJSONObject("data")?.optJSONArray("skills")?.let { arr ->
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { pluginSkills.add(it) }
        }
        pluginsFailed = mcp == null && sk == null
        pluginsLoading = false
    }

    /*
     * The project rows, in the desktop's recency order: the later of a
     * project's newest conversation and its last pick first, the stored list
     * breaking ties (`projectsByRecency` in shared/projects.ts).
     */
    val projectRows = remember(projects.toList(), projectNames.toMap(), projectUsed.toMap(), sessions.toList()) {
        val at = HashMap<String, Long>()
        for (d in projects) at[d] = projectUsed[d] ?: 0L
        // The count and the last touch in one pass. Counting with
        // `sessions.count { }` inside `projects.map { }` was O(projects x
        // sessions) on every recomposition of the drawer.
        val counts = HashMap<String, Int>()
        for (s in sessions) {
            counts[s.directory] = (counts[s.directory] ?: 0) + 1
            val seen = at[s.directory]
            if (seen != null && s.updated > seen) at[s.directory] = s.updated
        }
        val order = HashMap<String, Int>()
        for ((index, d) in projects.withIndex()) order[d] = index
        projects.map { d ->
            ProjectRowData(
                directory = d,
                name = projectNames[d] ?: d.substringAfterLast('\\').substringAfterLast('/'),
                sessions = counts[d] ?: 0,
                lastUsed = at[d] ?: 0L,
            )
        }.sortedWith(
            compareByDescending<ProjectRowData> { it.lastUsed }
                .thenBy { order[it.directory] ?: Int.MAX_VALUE },
        )
    }

    if (leftMode == LeftMode.Projects) {
        ProjectsScreen(
            rows = projectRows,
            onOpen = {
                projectFilter = it
                leftMode = LeftMode.Sessions
            },
            onClose = { leftMode = LeftMode.Sessions },
            onCreateBlank = { name ->
                scope.launch {
                    /*
                     * `project.createBlank` only makes the folder - the desktop's
                     * home then opens the first conversation in it, which is
                     * what puts the project on the list (a folder with no
                     * conversation is adopted only once it is used). So the
                     * three steps go together: the folder, the list, the turn.
                     */
                    val made = runCatching {
                        rpc(JSONObject().put("type", "project.createBlank").put("name", name))
                    }.getOrNull()?.optJSONObject("data")?.optString("directory").orEmpty()
                    if (made.isBlank()) {
                        Toast.makeText(context, "没有创建成功", Toast.LENGTH_SHORT).show()
                    } else {
                        runCatching {
                            rpc(JSONObject().put("type", "project.add").put("directory", made).put("used", true))
                        }
                        refreshCommandsTick++
                        newSession(made)
                    }
                }
            },
            onAddFolder = { directory ->
                scope.launch {
                    /*
                     * The server accepts a path whose ancestors exist - it
                     * walks up to the nearest real directory and joins the rest
                     * back on, which is how the desktop lets a project folder be
                     * made later. A tablet reader typing a path by hand has no
                     * way to see that, though: a typo became a project row
                     * pointing at nothing. So the folder is checked here first,
                     * and a mistyped one is refused with the sentence saying so.
                     */
                    val exists = runCatching {
                        rpc(
                            JSONObject().put("type", "file.listDir")
                                .put("directory", directory).put("sub", ""),
                            8_000,
                        ).optJSONObject("data")?.has("entries") == true
                    }.getOrDefault(false)
                    if (!exists) {
                        Toast.makeText(context, "文件夹不存在：$directory", Toast.LENGTH_LONG).show()
                        return@launch
                    }
                    val reply = runCatching {
                        rpc(JSONObject().put("type", "project.add").put("directory", directory).put("used", true))
                    }.getOrNull()?.optJSONObject("data")
                    refreshCommandsTick++
                    if (reply == null) Toast.makeText(context, "文件夹没有添加成功", Toast.LENGTH_SHORT).show()
                    else if (reply.optBoolean("existed")) Toast.makeText(context, "该项目已在列表中", Toast.LENGTH_SHORT).show()
                    else Toast.makeText(context, "已添加项目：${directory.substringAfterLast('\\').substringAfterLast('/')}", Toast.LENGTH_SHORT).show()
                }
            },
            onRename = { directory, name ->
                scope.launch {
                    runCatching {
                        val config = runCatching { rpc(JSONObject().put("type", "config.get")) }.getOrNull()
                            ?.optJSONObject("data")?.optJSONObject("config")
                        val names = config?.optJSONObject("projectNames")?.let { obj ->
                            val m = org.json.JSONObject()
                            for (key in obj.keys()) m.put(key, obj.optString(key))
                            m
                        } ?: org.json.JSONObject()
                        names.put(directory, name)
                        rpc(JSONObject().put("type", "config.set").put("patch", JSONObject().put("projectNames", names)))
                    }
                    refreshCommandsTick++
                }
            },
            onRemove = { directory ->
                scope.launch {
                    runCatching {
                        rpc(JSONObject().put("type", "project.remove").put("directories", org.json.JSONArray().put(directory)))
                    }
                    if (projectFilter == directory) projectFilter = null
                    refreshCommandsTick++
                    Toast.makeText(context, "已移除项目", Toast.LENGTH_SHORT).show()
                }
            },
        )
        return
    }

    var usageSummary by remember { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(leftMode) {
        if (leftMode != LeftMode.Settings || usageSummary != null) return@LaunchedEffect
        usageSummary = runCatching {
            rpc(JSONObject().put("type", "usage.summary").put("days", 30), 30_000)
        }.getOrNull()?.optJSONObject("data")
    }
    if (leftMode == LeftMode.Settings) {
        SettingsScreen(
            config = appConfig,
            archived = sessions.filter { it.archived },
            usage = usageSummary,
            providers = providers,
            servers = pluginServers.toList(),
            onPatch = { patch ->
                scope.launch {
                    runCatching { rpc(JSONObject().put("type", "config.set").put("patch", patch)) }
                    appConfig = runCatching { rpc(JSONObject().put("type", "config.get")) }
                        .getOrNull()?.optJSONObject("data")?.optJSONObject("config")
                    refreshCommandsTick++
                }
            },
            onReopen = { id ->
                scope.launch {
                    runCatching {
                        rpc(JSONObject().put("type", "session.archive").put("sessionID", id).put("archived", false))
                    }
                    leftMode = LeftMode.Sessions
                    select(id)
                }
            },
            onClose = { leftMode = LeftMode.Sessions },
        )
        return
    }

    if (leftMode == LeftMode.Plugins) {
        PluginsScreen(
            servers = pluginServers.toList(),
            skills = pluginSkills.toList(),
            loading = pluginsLoading,
            failed = pluginsFailed,
            onRefresh = { refreshPlugins++ },
            onToggleSkill = { name, enabled ->
                scope.launch {
                    /*
                     * `disabledSkills` is the field the loader reads, and the
                     * desktop toggles it the same way: read the config, change
                     * the one list, write it back.
                     */
                    val config = runCatching { rpc(JSONObject().put("type", "config.get")) }
                        .getOrNull()?.optJSONObject("data")?.optJSONObject("config")
                    val off = config?.optJSONArray("disabledSkills")?.let { arr ->
                        (0 until arr.length()).mapNotNull { arr.optString(it).ifBlank { null } }.toMutableList()
                    } ?: mutableListOf()
                    if (enabled) off.remove(name) else if (name !in off) off.add(name)
                    runCatching {
                        rpc(
                            JSONObject().put("type", "config.set")
                                .put("patch", JSONObject().put("disabledSkills", org.json.JSONArray(off))),
                        )
                    }
                    refreshPlugins++
                }
            },
            onClose = { leftMode = LeftMode.Sessions },
        )
        return
    }

    if (leftMode == LeftMode.Artifacts) {
        ArtifactsScreen(
            groups = artifacts.toList(),
            loading = artifactsLoading,
            failed = artifactsFailed,
            facets = artFacets,
            category = artCategory,
            query = artQuery,
            onQuery = { artQuery = it },
            onCategory = { artCategory = it },
            onRefresh = { refreshArtifacts++ },
            onOpen = { root, rel -> openArtifact(root, rel) },
            onClose = { leftMode = LeftMode.Sessions },
        )
        return
    }

    // Claude keeps the single-pane layout in portrait even on the big inner
    // screen; only the expanded width class (the fold in landscape) goes two-pane.
    val wide = widthSize >= WindowWidthSizeClass.Expanded
    val empty = items.isEmpty()

    // 项目/运行中过滤后的列表；模型 pill 显示当前会话的真实模型。
    val visibleSessions = sessions.filter { (projectFilter == null || it.directory == projectFilter) && (!runningOnly || it.running) }
    /*
     * How many times the needle appears in this conversation, and in which
     * message each hit sits - the two things the card's `cur/total` and the
     * stepping both need. The desktop counts text nodes under the pane; the
     * transcript's own strings are the same text here.
     */
    val findMatches: List<Pair<Int, Int>> = remember(items.toList(), findQuery) {
        val needle = findQuery
        if (needle.isBlank()) emptyList() else buildList {
            for ((index, item) in items.toList().withIndex()) {
                val body = when (item) {
                    is Item.Msg -> item.text
                    is Item.Tool -> item.title + " " + item.output
                    else -> ""
                }
                var at = body.indexOf(needle, 0, ignoreCase = true)
                while (at >= 0) {
                    add(index to at)
                    at = body.indexOf(needle, at + needle.length, ignoreCase = true)
                }
            }
        }
    }
    val findCount = findMatches.size
    val currentRow = sessions.find { it.id == currentSession }
    val currentModel = currentRow?.model?.takeIf { it.isNotBlank() } ?: "本地模型"
    /*
     * A session stores the model's id (`qwen3.8-flash-next-iq3_s`); the name
     * the provider gives it (`Qwen3.8-Flash-Next`) is what the model picker
     * shows and what the desktop puts in its pill. Look the name up in what the
     * picker already loaded, so both places agree.
     */
    val displayModel = remember(currentModel, providers) {
        var found = currentModel
        for (provider in providers) {
            val models = provider.optJSONArray("models") ?: continue
            for (index in 0 until models.length()) {
                val model = models.optJSONObject(index) ?: continue
                if (model.optString("id") == currentModel) {
                    found = model.optString("name").ifBlank { currentModel }
                    break
                }
            }
            if (found != currentModel) break
        }
        found
    }
    /*
     * The window this conversation's model reports, from the same provider list
     * the picker draws. The desktop falls back to the model's `contextWindow`
     * when the transcript carries no limit of its own (`contextUsage` in
     * Composer.vue); a model nobody has told it about leaves the ring empty and
     * the card says only what was spent.
     */
    val contextWindow = remember(currentModel, providers) {
        var found = 0
        for (provider in providers) {
            val models = provider.optJSONArray("models") ?: continue
            for (index in 0 until models.length()) {
                val model = models.optJSONObject(index) ?: continue
                if (model.optString("id") == currentModel) {
                    found = model.optInt("contextWindow", 0)
                    break
                }
            }
            if (found > 0) break
        }
        found
    }
    /*
     * Claude's pill carries the model and what it is thinking with ("Sonnet 5.5
     * 中等"), so the same two facts belong in ours. Effort is only named when
     * the session has one picked - "none" reads as absent, not as a level.
     */
    val effortLabel = when (currentRow?.effort) {
        "minimal" -> "最少"
        "low" -> "低"
        "medium" -> "中等"
        "high" -> "高"
        "xhigh" -> "很高"
        "max" -> "最高"
        else -> ""
    }
    // "Smart" replaces the model's name when the session lets the app pick one,
    // which is what the desktop's pill does.
    val shownModel = if (smartMode) "Smart" else displayModel
    val currentModelLabel = if (effortLabel.isNotEmpty()) "$shownModel $effortLabel" else shownModel

    // The folder decides which commands exist, so this follows the session.
    val commandDir = sessions.find { it.id == currentSession }?.directory.orEmpty()
    /**
     * The folder's skills, by name, for the plus menu's 技能 submenu.
     *
     * `command.list` is what the slash menu already reads; it carries each
     * entry's `source`, so a skill is the ones marked `skill` rather than a
     * second round trip to `skill.list`.
     */
    val skills = remember { mutableStateListOf<String>() }
    LaunchedEffect(commandDir) {
        commands.clear()
        skills.clear()
        val ticket = "cmd${System.nanoTime()}"
        val deferred = client.awaitResponse(ticket)
        request(JSONObject().put("type", "command.list").put("directory", commandDir), ticket)
        val res = try {
            runCatching { deferred.await() }.getOrNull()
        } finally {
            client.forgetResponse(ticket)
        } ?: return@LaunchedEffect
        val arr = res.optJSONObject("data")?.optJSONArray("commands") ?: return@LaunchedEffect
        for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            val name = c.optString("name")
            if (name.isNotBlank()) commands.add(name to c.optString("description", ""))
            if (name.isNotBlank() && c.optString("source") == "skill") skills.add(name)
        }
    }

    val inputBar: @Composable () -> Unit = {
        InputCapsule(
            enabled = currentSession != null,
            modelLabel = currentModelLabel,
            contextUsed = contextUsed,
            contextLimit = if (contextWindow > 0) contextWindow else contextLimit,
            onMic = { startVoice() },
            listening = recording != null,
            transcribing = voiceBusy,
            inject = voiceText,
            onInjected = { voiceText = null },
            onModel = { loadProviders(); modelPicker = true },
            directory = sessions.find { it.id == currentSession }?.directory.orEmpty(),
            atListDir = { dir ->
                val r = runCatching { rpc(JSONObject().put("type", "file.listDir").put("directory", dir).put("sub", "")) }.getOrNull()
                val arr = r?.optJSONObject("data")?.optJSONArray("entries")
                val list = mutableListOf<Pair<String, Boolean>>()
                if (arr != null) for (i in 0 until arr.length()) {
                    val e = arr.optJSONObject(i) ?: continue
                    list.add(e.optString("name") to (e.optString("type") == "dir"))
                }
                list.sortedWith(compareByDescending<Pair<String, Boolean>> { it.second }.thenBy { it.first }).take(8)
            },
            atSearch = { dir, query ->
                val r = runCatching {
                    rpc(JSONObject().put("type", "file.search").put("directory", dir).put("query", query).put("limit", 8))
                }.getOrNull()
                val arr = r?.optJSONObject("data")?.optJSONArray("entries")
                val list = mutableListOf<Pair<String, String>>()
                if (arr != null) for (i in 0 until arr.length()) {
                    val e = arr.optJSONObject(i) ?: continue
                    val rel = e.optString("rel")
                    if (rel.isNotBlank()) list.add(e.optString("name") to rel)
                }
                list
            },
            access0 = accessOf(sessions.find { it.id == currentSession }, appConfig),
            fullAllowed = appConfig?.optBoolean("allowFullAccess") != false || accessOf(sessions.find { it.id == currentSession }, appConfig) == "full",
            onAccess = { level ->
                currentSession?.let { sid ->
                    scope.launch {
                        runCatching { rpc(JSONObject().put("type", "session.access").put("sessionID", sid).put("access", level)) }
                        val at = sessions.indexOfFirst { it.id == sid }
                        if (at >= 0) sessions[at] = sessions[at].copy(access = level)
                    }
                }
            },
            running = sessions.find { it.id == currentSession }?.running == true,
            attachments = attachments.toList(),
            onRemoveAttachment = { attachments.removeAt(it) },
            pickImages = { pickImages() },
            commands = commands.toList(),
            queued = queuedPrompts.toList(),
            // The plus menu's own rows, which the desktop has and the phone did not.
            onFiles = { showFiles = true; fileStack = listOf("") },
            onTerminal = { showTerminal = true },
            goalMode = goalMode,
            onToggleGoalMode = {
                val next = !goalMode
                goalMode = next
                currentSession?.let { sid ->
                    scope.launch {
                        runCatching {
                            rpc(JSONObject().put("type", "session.goalMode").put("sessionID", sid).put("on", next))
                        }.onFailure {
                            // A write that fails puts the switch back, as the
                            // desktop's does, rather than lying about it.
                            goalMode = !next
                            withContext(Dispatchers.Main) {
                                Toast.makeText(context, "无法开启目标模式", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                }
            },
            skills = skills.toList(),
            goal = currentRow?.goal,
            onGoalRemove = {
                currentSession?.let { sid ->
                    scope.launch {
                        runCatching { rpc(JSONObject().put("type", "session.goal").put("sessionID", sid).put("condition", JSONObject.NULL)) }
                        runCatching { rpc(JSONObject().put("type", "session.goalMode").put("sessionID", sid).put("on", false)) }
                        withContext(Dispatchers.Main) { goalMode = false }
                    }
                }
            },
            onGoalResend = {
                val condition = currentRow?.goal?.condition
                val sessionID = currentSession
                if (!condition.isNullOrBlank() && sessionID != null) {
                    scope.launch {
                        runCatching {
                            rpc(JSONObject().put("type", "session.goal").put("sessionID", sessionID).put("condition", condition))
                            rpc(JSONObject().put("type", "session.prompt").put("sessionID", sessionID).put("text", condition))
                            // The reader may have left this conversation while the
                            // two round trips were out; the row it names is still
                            // the one that started running, so the id is taken
                            // before the calls rather than re-read after them.
                            withContext(Dispatchers.Main) { setRunning(sessionID, true) }
                        }
                    }
                }
            },
            onGoalEdit = { goalEdit = currentRow?.goal?.condition ?: "" },
            draftKey = currentSession.orEmpty(),
            draft = drafts[currentSession.orEmpty()].orEmpty(),
            onDraftChange = { words ->
                val key = currentSession.orEmpty()
                if (key.isEmpty()) return@InputCapsule
                if (words.isEmpty()) drafts.remove(key) else drafts[key] = words
                // Written on the same beat as the desktop's 300ms, and cleared
                // outright when the box is emptied so a stale line cannot come
                // back after a restart.
                if (words.isEmpty()) draftStore.edit().remove("draft.$key").apply()
                else draftStore.edit().putString("draft.$key", words).apply()
            },
            /*
             * Both take the id and leave if there is none. `currentSession!!`
             * was an NPE waiting for the reader to switch away from a
             * conversation with a queued message - the queue belongs to the
             * conversation it was drawn in, and by the time the tap lands that
             * one may no longer be the open one.
             */
            onQueueRemove = { id ->
                queuedPrompts.removeAll { it.first == id }
                currentSession?.let { sid ->
                    request(JSONObject().put("type", "session.queue.remove").put("sessionID", sid).put("id", id))
                }
            },
            onQueueSend = { id ->
                currentSession?.let { sid ->
                    request(JSONObject().put("type", "session.queue.send").put("sessionID", sid).put("id", id))
                }
            },
            onSend = { text, atts ->
                // steer only joins a running turn; an idle session gets a
                // plain prompt or the server ignores the message outright.
                // send is only enabled with a conversation open, but the
                // composer can be rebuilt after it closes; leave rather than
                // throw if that has happened.
                val sid = currentSession ?: return@InputCapsule
                val req = JSONObject().put("type", "session.prompt").put("sessionID", sid).put("text", text)
                if (atts.isNotEmpty()) req.put("attachments", org.json.JSONArray(atts.toList()))
                if (sessions.find { it.id == sid }?.running == true) req.put("delivery", "steer")
                /*
                 * 追求目标: with the switch on, what was typed becomes the goal
                 * the turn is judged against - the words as typed, which is
                 * what `session.prompt`'s own `goal` field takes.
                 */
                if (goalMode && text.isNotBlank()) req.put("goal", text.trim())
                request(req)
                // The round button turns into stop the moment the prompt
                // leaves, the way Claude's does, rather than waiting for the
                // first reply part to come back.
                setRunning(sid, true)
                attachments.clear()
                // A sent message is no longer a draft; without this the words
                // came back in the box on the next visit.
                drafts.remove(sid)
                draftStore.edit().remove("draft.$sid").apply()
            },
            onStop = { currentSession?.let { request(JSONObject().put("type", "session.abort").put("sessionID", it)) } },
        )
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        /*
         * Claude's scrim is a light veil, not a blackout: 169,169,168 over a
         * 249,249,247 page, which leaves the conversation readable behind the
         * sheet. Material's default darkens the page to nearly black and made
         * the drawer look like a separate screen.
         */
        scrimColor = if (LocalBg.current == DarkBg) Color(0xD9000000) else Color(0x52000000),
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = MaterialTheme.colorScheme.background) {
                DrawerContent(
                    sessions = sessions,
                    onSelect = { select(it); closeDrawer() },
                    onCreate = {
                        newSession()
                        closeDrawer()
                    },
                    onReconnect = { showConnect = true; closeDrawer() },

                    // The drawer's search closes the drawer and focuses the
                    // list's field; on a phone the list is the page behind it.
                    onSearch = { closeDrawer() },
                    onSeeAll = { openDrawer() },
                    onNewTask = { newSession(); closeDrawer() },
                    onArtifacts = { leftMode = LeftMode.Artifacts; closeDrawer() },
                    onPlugins = { leftMode = LeftMode.Plugins; closeDrawer() },
                    onProjects = { leftMode = LeftMode.Projects; closeDrawer() },
                    onSettings = { leftMode = LeftMode.Settings; closeDrawer() },
                    currentPage = leftMode,
                    onLongPress = { sheetTarget = it },
                    unseen = unseen.toList(),
                    awaiting = pendingPerms.filterValues { it.isNotEmpty() }.keys.toList(),
                )
            }
        },
    ) {
        if (wide) {
            // Claude's fold layout: each pane owns its header - the list's
            // (menu, records, filter, tasks) and the conversation's (title,
            // privacy) - with the divider running the full height between.
            // Only the navigation bar shortens the row: the keyboard belongs to the
            // conversation pane, and having it shrink the list too was pulling
            // the new-chat pill up into the middle of the column.
            Row(
                Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background)
                    .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                    .onSizeChanged { paneWidthPx = it.width },
            ) {
                /*
                 * Claude's split is 900 of 3408 px on the pad - 26.4% - not the
                 * 42% this used to take. Both panes share the page's own colour
                 * and no rule runs between them; only the composer's white card
                 * marks where the conversation begins.
                 */
                Column(Modifier.weight(leftFraction).fillMaxHeight().fillMaxWidth()) {
                    Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                    // The wide layout's own header, so both notices have to be
                    // hung here as well as under `AppTopBar`.
                    if (!connected) OfflineStrip()
                    lastError?.let { msg -> ErrorStrip(msg) { lastError = null } }
                    Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        /*
                         * Claude's list header: menu at the far left, the title
                         * centred, the two glyphs at the right. They are plain
                         * 36dp targets rather than IconButtons, whose 48dp
                         * minimum width ate the column and left the title one
                         * character wide.
                         */
                        /*
                         * On the list this is the drawer's menu; on the other
                         * two pages it is the way back to the list, which is
                         * what Claude's own header puts at that corner once a
                         * page has been opened.
                         */
                        Box(
                            Modifier.size(44.dp).clickable {
                                if (leftMode == LeftMode.Sessions) openDrawer() else leftMode = LeftMode.Sessions
                            },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                if (leftMode == LeftMode.Sessions) Icons.Outlined.Menu else Icons.AutoMirrored.Outlined.ArrowBack,
                                contentDescription = if (leftMode == LeftMode.Sessions) "菜单" else "返回列表",
                                tint = LocalText.current,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                        Text(
                            if (leftMode == LeftMode.Artifacts) "产物中心" else "最近记录",
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Medium,
                            color = LocalText.current,
                            maxLines = 1,
                            softWrap = false,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            modifier = Modifier.weight(1f),
                        )
                        /*
                         * Claude's header ends with a magnifier and a filter,
                         * and the search field is not on the page until it is
                         * asked for: a permanent 45dp box over a list of rows
                         * takes the space of two rows to do nothing. The
                         * magnifier opens it; the field then sits above the list
                         * with a close glyph that puts it away.
                         */
                        Box(Modifier.size(38.dp).clickable { searching = !searching; if (!searching) search = "" }, contentAlignment = Alignment.Center) {
                            Icon(
                                if (searching) Icons.Filled.Close else Icons.Outlined.Search,
                                contentDescription = if (searching) "关闭搜索" else "搜索",
                                tint = LocalText.current,
                                modifier = Modifier.size(19.dp),
                            )
                        }
                        Box(Modifier.size(38.dp).clickable { runningOnly = !runningOnly }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Tune, contentDescription = "筛选", tint = if (runningOnly) MaterialTheme.colorScheme.primary else LocalText.current, modifier = Modifier.size(18.dp))
                        }
                    }
                    /*
                     * The field appears only while searching, and takes the
                     * focus as it does - a magnifier that opened a box the
                     * reader then had to tap again would be two gestures for one
                     * intent.
                     */
                    if (searching) {
                        val focus = remember { androidx.compose.ui.focus.FocusRequester() }
                        LaunchedEffect(searching) {
                            if (searching) withContext(kotlinx.coroutines.Dispatchers.Main) { runCatching { focus.requestFocus() } }
                        }
                        OutlinedTextField(
                            search, { search = it },
                            /*
                             * `heightIn`, not `height`: a fixed 45dp box with a
                             * 14sp field and Material's own inner padding left the
                             * placeholder clipped - 「搜索」 rendered as a cut-off
                             * glyph pair.
                             */
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp).heightIn(min = 45.dp).focusRequester(focus),
                            placeholder = { Text("搜索", color = LocalMuted.current, fontSize = 14.sp) },
                            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(17.dp)) },
                            shape = RoundedCornerShape(14.dp),
                            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                            // Claude's search sits on white with a hairline pill
                            // outline, not on the page's own colour with none.
                            colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = LocalField.current, focusedContainerColor = LocalField.current, unfocusedBorderColor = LocalFieldLine.current, focusedBorderColor = LocalFieldLine.current),
                            singleLine = true,
                        )
                    }
                        /*
                         * The body hits sit between the field and the list, the
                         * way the desktop's overlay puts its 消息 group above
                         * the rest: the words are what the reader is hunting,
                         * and the conversations that hold them come second.
                         */
                        if (searching && search.isNotBlank() && foundHits.isNotEmpty()) {
                            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                                Text(
                                    "消息",
                                    fontSize = 11.sp,
                                    color = LocalMuted.current,
                                    modifier = Modifier.padding(start = 2.dp, top = 2.dp, bottom = 3.dp),
                                )
                                for (hit in foundHits.take(6)) {
                                    val sid = hit.optString("sessionID")
                                    val text = hit.optString("text")
                                    val title = sessions.find { it.id == sid }?.title.orEmpty()
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(9.dp))
                                            .clickable { select(sid); searching = false }
                                            .padding(horizontal = 6.dp, vertical = 6.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            if (title.isNotBlank()) Text(title, fontSize = 12.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            /*
                                             * The server hands back one line around the
                                             * words with `ranges` marking them, so the
                                             * mark is drawn from those rather than
                                             * searched for again.
                                             */
                                            val marked = buildAnnotatedString {
                                                append(text)
                                                hit.optJSONArray("ranges")?.let { ranges ->
                                                    for (k in 0 until ranges.length()) {
                                                        val r = ranges.optJSONObject(k) ?: continue
                                                        val s0 = r.optInt("start", 0).coerceIn(0, text.length)
                                                        val e0 = r.optInt("end", 0).coerceIn(s0, text.length)
                                                        addStyle(androidx.compose.ui.text.SpanStyle(background = Color(0x8CF6C77A)), s0, e0)
                                                    }
                                                }
                                            }
                                            Text(marked, fontSize = 12.sp, color = LocalMuted.current, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                }
                            }
                        }
                        /*
                         * The project the list is filtered to, as a chip with a
                         * clear: picking a project on the projects page lands
                         * here, and without a visible state the list would
                         * silently have become three rows long.
                         */
                        if (projectFilter != null) {
                            Row(
                                Modifier
                                    .padding(horizontal = 12.dp, vertical = 2.dp)
                                    .clip(RoundedCornerShape(15.dp))
                                    .background(LocalPill.current)
                                    .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(Icons.Outlined.Folder, contentDescription = null, tint = Ember, modifier = Modifier.size(13.dp))
                                Spacer(Modifier.width(5.dp))
                                Text(
                                    projectNames[projectFilter] ?: (projectFilter ?: "").substringAfterLast('\\').substringAfterLast('/'),
                                    fontSize = 12.sp,
                                    color = LocalText.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                Spacer(Modifier.width(3.dp))
                                Box(Modifier.size(22.dp).clickable { projectFilter = null }, contentAlignment = Alignment.Center) {
                                    Icon(Icons.Filled.Close, contentDescription = "清除项目过滤", tint = LocalMuted.current, modifier = Modifier.size(13.dp))
                                }
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                        SessionList(
                            visibleSessions,
                            currentSession,
                            search,
                            onSelect = { select(it) },
                            compact = false,
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            onLongPress = { sheetTarget = it },
                            unseen = unseen.toList(),
                            awaiting = pendingPerms.filterValues { it.isNotEmpty() }.keys.toList(),
                        )
                        /*
                         * Claude's foot-of-column capsule, which follows the
                         * mode: 新建会话 on the list, 新建项目 on the projects
                         * page, 新建任务 on the scheduled one. It is laid out
                         * after the list so the list takes the space first and
                         * the capsule never covers a row.
                         */
                        FootCapsule(
                            /*
                             * The desktop's capsule reads 新建任务 and makes a
                             * conversation wherever the list is showing; it is
                             * one row with one job, not a menu whose words change.
                             */
                            label = "+ 新建会话",
                            modifier = Modifier.align(Alignment.CenterHorizontally),
                            onClick = { newSession() },
                        )
                    }
                    /*
                     * Claude's divider is not a rule but a handle: a 4dp wide,
                     * 48dp tall rounded bar in (216,216,214), centred in the
                     * pane's height, which the reader drags to trade width
                     * between the two sides. There is no line at all - the two
                     * panes share the page colour - so without this the split
                     * cannot be moved and, more to the point, does not look
                     * like it can be.
                     */
                    ColumnDivider(
                        fraction = leftFraction,
                        totalWidthPx = paneWidthPx,
                        onChange = { leftFraction = it },
                    )
                    Column(Modifier.weight(1f - leftFraction).fillMaxHeight().fillMaxWidth()) {
                        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            /*
                             * Claude's conversation header: a back arrow at the
                             * pane's left edge, the title centred with what the
                             * conversation is attached to under it, then the
                             * clock and the overflow at the right.
                             */
                            /*
                             * Read once for the whole header: the title needs the
                             * folder, and the clock's amber ring needs to know a
                             * turn is in flight (and how to stop it).
                             */
                            val runningNow = sessions.find { it.id == currentSession }?.running == true
                            val stopHere: (String) -> Unit = { sid ->
                                request(JSONObject().put("type", "session.abort").put("sessionID", sid))
                            }
                            Box(Modifier.size(44.dp).clickable { openDrawer() }, contentAlignment = Alignment.Center) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(20.dp))
                            }
                            /*
                             * Ctrl+F, as a magnifier: the desktop has the chord
                             * and no button for it, but a tablet has no keyboard
                             * to press it on - and a long transcript is exactly
                             * where one wants it.
                             */
                            Box(
                                Modifier.size(38.dp).clickable { findOpen = !findOpen; if (!findOpen) findQuery = "" },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Outlined.Search,
                                    contentDescription = if (findOpen) "关闭查找" else "在对话中查找",
                                    tint = if (findOpen) MaterialTheme.colorScheme.primary else LocalText.current,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            Column(
                                Modifier.weight(1f).clickable { toTopTicks++ },
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Text(currentSessionTitle(sessions, currentSession), fontSize = 16.sp, fontWeight = FontWeight.Medium, color = LocalText.current, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                                val where = sessions.find { it.id == currentSession }?.directory.orEmpty()
                                if (where.isNotBlank()) {
                                    Text(
                                        where.substringAfterLast('\\').substringAfterLast('/'),
                                        fontSize = 11.sp,
                                        color = LocalMuted.current,
                                        maxLines = 1,
                                        softWrap = false,
                                    )
                                }
                            }
                            /*
                             * While a turn is in flight Claude puts an amber ring
                             * beside the clock - 239,181,68, 16dp across - instead
                             * of leaving the header still. It reads as work in
                             * progress and as the way to stop it, which is what the
                             * running turn needs from the top of the screen.
                             */
                            if (runningNow) {
                                Box(
                                    Modifier.size(40.dp).clickable { currentSession?.let { stopHere(it) } },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    androidx.compose.material3.CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        strokeWidth = 2.dp,
                                        color = Color(0xFFEFB544),
                                    )
                                }
                            }
                            /*
                             * Claude closes this header with the overflow rather
                             * than a glyph of its own; the actions that used to
                             * sit here (the privacy blur among them) belong in
                             * that menu, which is where the phone keeps the ones
                             * with no room of their own.
                             */
                            var headerMenu by remember { mutableStateOf(false) }
                            Box(Modifier.size(40.dp).clickable { headerMenu = true }, contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.MoreVert, contentDescription = "更多", tint = LocalText.current, modifier = Modifier.size(20.dp))
                                DropdownMenu(expanded = headerMenu, onDismissRequest = { headerMenu = false }) {
                                    MenuRow(
                                        label = if (privacy) "关闭隐私模糊" else "隐私模糊",
                                        onClick = { privacy = !privacy; headerMenu = false },
                                        icon = { GhostGlyph(active = privacy, size = 15.dp) },
                                    )
                                    MenuRow(label = "重命名", onClick = { headerMenu = false; renameTarget = sessions.find { it.id == currentSession } })
                                    /*
                                     * The desktop's undo: take the last turn's file
                                     * edits back. It had no phone counterpart at
                                     * all, so a turn that broke a file could only
                                     * be repaired by hand.
                                     */
                                    MenuRow(label = "撤销上一回合的改动", onClick = {
                                            headerMenu = false
                                            currentSession?.let { sid ->
                                                request(JSONObject().put("type", "session.undo").put("sessionID", sid))
                                            }
                                        })
                                    MenuRow(label = "重做撤销", onClick = {
                                            headerMenu = false
                                            currentSession?.let { sid ->
                                                request(JSONObject().put("type", "session.redo").put("sessionID", sid))
                                            }
                                        })
                                    MenuRow(label = if (runningOnly) "显示全部会话" else "只看运行中", onClick = { headerMenu = false; runningOnly = !runningOnly })
                                    MenuRow(label = "项目文件", onClick = { headerMenu = false; showFiles = true; fileStack = listOf("") })
                                    MenuRow(label = "本次改动", onClick = { headerMenu = false; showChanges = true })
                                }
                            }
                        }
                        // The conversation pane, and only it, rides above the IME.
                        Column(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.ime.only(WindowInsetsSides.Bottom))) {
                            if (empty && loadingThread) {
                                ThreadLoading()
                            } else if (empty) {
                                WelcomePane(withInput = true, inputBar = inputBar, inputAtBottom = true)
                            } else {
                                Column(Modifier.fillMaxSize()) {
                                    Box(Modifier.weight(1f)) {
                                        Timeline(
                                            items,
                                            Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp),
                                            running = sessions.find { it.id == currentSession }?.running == true,
                                            onPerm = ::respondPerm,
                                            onPermReason = ::respondPermReason,
                                            onAnswer = ::answerQuestion,
                                            onMessage = { messageTarget = it },
                                            toTop = toTopTicks,
                                            onFixKey = { loadProviders(); showProviders = true },
                                            find = if (findOpen) findQuery else "",
                                            findStep = findStep,
                                            onOpenFile = { dir, rel -> openArtifact(dir, rel) },
                                            root = sessions.find { it.id == currentSession }?.directory.orEmpty(),
                                            onRevertTurn = ::revertTurn,
                                            onReviewTurn = { patch -> filePreview = "本回合的改动" to patch },
                                        )
                                        /*
                                         * The card hangs over the pane's top trailing
                                         * corner, 9 into it - the desktop puts it 54
                                         * below the pane's own top and 20 in from
                                         * its end, and the header here already
                                         * takes those first 54.
                                         */
                                        if (findOpen) FindCard(
                                            query = findQuery,
                                            onQuery = { findQuery = it; findStep = 0 },
                                            count = findCount,
                                            active = if (findCount == 0) 0 else Math.floorMod(findStep, findCount),
                                            onStep = { step -> findStep = findStep + step },
                                            onClose = { findOpen = false; findQuery = "" },
                                            modifier = Modifier.align(Alignment.TopEnd).padding(top = 9.dp, end = 20.dp),
                                        )
                                    }
                                    inputBar()
                                }
                            }
                        }
                    }
                }
        } else {
            if (empty) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    AppTopBar(filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onPrivacy = { privacy = !privacy }, findOpen = findOpen, onFind = { findOpen = !findOpen; if (!findOpen) findQuery = "" }, connected = connected)
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        WelcomePane(withInput = true, inputBar = inputBar)
                    }
                    Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)))
                }
            } else {
                Scaffold(
                    containerColor = MaterialTheme.colorScheme.background,
                    topBar = { AppTopBar(filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onPrivacy = { privacy = !privacy }, findOpen = findOpen, onFind = { findOpen = !findOpen; if (!findOpen) findQuery = "" }, connected = connected) },
                    bottomBar = {
                        Column {
                            inputBar()
                            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)))
                        }
                    },
                ) { padding ->
                    Box(Modifier.padding(padding).fillMaxSize()) {
                        Timeline(
                            items,
                            Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp),
                            running = sessions.find { it.id == currentSession }?.running == true,
                            onPerm = ::respondPerm,
                            onPermReason = ::respondPermReason,
                            onAnswer = ::answerQuestion,
                            onMessage = { messageTarget = it },
                            toTop = toTopTicks,
                            onFixKey = { loadProviders(); showProviders = true },
                            find = if (findOpen) findQuery else "",
                            findStep = findStep,
                            onOpenFile = { dir, rel -> openArtifact(dir, rel) },
                            root = sessions.find { it.id == currentSession }?.directory.orEmpty(),
                            onRevertTurn = ::revertTurn,
                            onReviewTurn = { patch -> filePreview = "本回合的改动" to patch },
                        )
                        if (findOpen) FindCard(
                            query = findQuery,
                            onQuery = { findQuery = it; findStep = 0 },
                            count = findCount,
                            active = if (findCount == 0) 0 else Math.floorMod(findStep, findCount),
                            onStep = { step -> findStep = findStep + step },
                            onClose = { findOpen = false; findQuery = "" },
                            modifier = Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 12.dp),
                        )
                    }
                }
            }
        }
    }

    /*
     * The terminal drawer.
     *
     * `shell.open` gives a pty in the conversation's folder; `shell.data`
     * streams what it prints, and `shell.input` types into it. The desktop keeps
     * this at the foot of the conversation permanently; on a tablet it is a
     * sheet, because a pty that shares the screen with the transcript shrinks
     * both. The gateway forwards the output of the shells a phone opened and
     * holds back every other window's, so what arrives here is this pane's own.
     */
    if (showTerminal) {
        val root = sessions.find { it.id == currentSession }?.directory.orEmpty()
        /*
         * Opened fully rather than at Material's half height: this sheet is a
         * terminal with a field under it, and half-expanded cut the field off
         * the bottom of the screen - the pane could be read and not typed into.
         */
        val termSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { showTerminal = false },
            sheetState = termSheet,
            containerColor = MaterialTheme.colorScheme.background,
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("终端", fontSize = 16.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        root.substringAfterLast('\\').substringAfterLast('/').ifBlank { "~" },
                        fontSize = 11.sp,
                        color = LocalMuted.current,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Box(
                        Modifier.size(30.dp).clickable {
                            // A terminal that has printed nothing and been
                            // typed into nothing is simply thrown away.
                            if (terminalText.isNotBlank()) {
                                terminalText = ""
                                terminalId = null
                            }
                        },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Outlined.DeleteOutline, contentDescription = "清屏", tint = LocalMuted.current, modifier = Modifier.size(16.dp))
                    }
                    Box(Modifier.size(30.dp).clickable { showTerminal = false }, contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, contentDescription = "关闭", tint = LocalMuted.current, modifier = Modifier.size(17.dp))
                    }
                }
                Spacer(Modifier.height(8.dp))
                // Opened on first show and kept while the sheet is up: a pty
                // restarted every time the drawer opens loses its history and
                // its working directory.
                LaunchedEffect(root) {
                    if (terminalId != null) return@LaunchedEffect
                    val opened = runCatching {
                        rpc(JSONObject().put("type", "shell.open").put("directory", root).put("cols", 100).put("rows", 40))
                    }.getOrNull() ?: return@LaunchedEffect
                    val id = opened.optJSONObject("data")?.optString("shellID").orEmpty()
                    if (id.isBlank()) return@LaunchedEffect
                    terminalId = id
                    val attached = runCatching { rpc(JSONObject().put("type", "shell.attach").put("shellID", id)) }.getOrNull()
                    val seen = attached?.optJSONObject("data")?.optString("data").orEmpty()
                    if (seen.isNotBlank()) terminalText = seen.takeLast(8000)
                }
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(360.dp)
                        .background(if (LocalBg.current == DarkBg) Color(0xFF0D0D0D) else Color(0xFF1B1B1B), RoundedCornerShape(10.dp))
                        .padding(8.dp),
                ) {
                        // A pty speaks in escape sequences: colours, cursor moves, and the
                        // `]0;title` a PowerShell prompt sets. A Text cannot act
                        // on any of them, so they are stripped rather than shown
                        // as `[?9001h[?1004h` at the head of every session.
                        val lines = stripAnsi(terminalText).lineSequence().toList().takeLast(400)
                        LazyColumn(Modifier.fillMaxSize()) {
                        items(lines.size.coerceAtLeast(1)) { i ->
                            Text(
                                lines.getOrElse(i) { "" }.ifEmpty { " " },
                                fontSize = 11.sp,
                                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                                color = Color(0xFFE6E6E0),
                                softWrap = true,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    terminalInput,
                    { terminalInput = it },
                    Modifier.fillMaxWidth(),
                    placeholder = { Text("输入命令后回车", fontSize = 13.sp, color = LocalMuted.current) },
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                    shape = RoundedCornerShape(10.dp),
                )
                Spacer(Modifier.height(6.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(
                        {
                            val id = terminalId ?: return@TextButton
                            val line = terminalInput + "\r"
                            request(JSONObject().put("type", "shell.input").put("shellID", id).put("data", line))
                            terminalInput = ""
                        },
                    ) { Text("运行") }
                }
            }
        }
    }

    /*
     * The project browser: the folder walked one level at a time, text files
     * shown as they are. The desktop has this as a permanent rail; on a tablet
     * it belongs in a sheet, opened from the header, and it is the shortest way
     * to answer "what is actually in this repository" from a phone.
     */
    if (showFiles) {
        val root = sessions.find { it.id == currentSession }?.directory.orEmpty()
        val sub = fileStack.last()
        LaunchedEffect(root, sub) {
            fileEntries.clear()
            filePreview = null
            val ticket = "fs${System.nanoTime()}"
            val deferred = client.awaitResponse(ticket)
            request(JSONObject().put("type", "file.listDir").put("directory", root).put("sub", sub), ticket)
            val res = try {
                runCatching { deferred.await() }.getOrNull()
            } finally {
                client.forgetResponse(ticket)
            } ?: return@LaunchedEffect
            val arr = res.optJSONObject("data")?.optJSONArray("entries") ?: return@LaunchedEffect
            val list = mutableListOf<Pair<String, Boolean>>()
            for (i in 0 until arr.length()) {
                val e = arr.optJSONObject(i) ?: continue
                list.add(e.optString("name") to (e.optString("type") == "dir"))
            }
            fileEntries.addAll(list.sortedWith(compareByDescending<Pair<String, Boolean>> { it.second }.thenBy { it.first }))
        }
        ModalBottomSheet(onDismissRequest = { showFiles = false }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (fileStack.size > 1) {
                        Box(Modifier.size(36.dp).clickable { fileStack = fileStack.dropLast(1) }, contentAlignment = Alignment.Center) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "上一级", tint = LocalText.current, modifier = Modifier.size(18.dp))
                        }
                    }
                    Text(
                        "/" + sub,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Medium,
                        color = LocalText.current,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(start = if (fileStack.size > 1) 4.dp else 0.dp),
                    )
                }
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 460.dp)) {
                    items(fileEntries.size) { index ->
                        val (name, isDir) = fileEntries[index]
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    if (isDir) {
                                        fileStack = fileStack + if (sub.isBlank()) name else "$sub/$name"
                                    } else {
                                        /*
                                         * The one open path, shared with the
                                         * artifacts page: it was a second copy of
                                         * the same read here, and its text-only
                                         * branch handed a video an empty sheet.
                                         */
                                        openArtifact(root, if (sub.isBlank()) name else "$sub/$name")
                                    }
                                }
                                .padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (isDir) Icons.Outlined.Folder else Icons.AutoMirrored.Outlined.Article,
                                contentDescription = null,
                                tint = LocalMuted.current,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }

    /*
     * The changes rail. A turn that edited files is the thing most worth
     * checking from a phone, and until now the only way was to ask the model
     * what it had done.
     */
    if (showChanges) {
        val root = sessions.find { it.id == currentSession }?.directory.orEmpty()
        LaunchedEffect(root) {
            changedFiles.clear()
            val r = runCatching { rpc(JSONObject().put("type", "git.status").put("directory", root)) }.getOrNull()
            val data = r?.optJSONObject("data") ?: return@LaunchedEffect
            changeBranch = data.optString("branch")
            /*
             * A folder that is not a repository has no changes, and saying only
             * that is a lie of omission: the reader closes the panel believing
             * the tree is clean. `repo: false` is the answer, and it is shown.
             */
            changesNoRepo = data.has("repo") && !data.optBoolean("repo")
            changesNoGit = data.has("installed") && !data.optBoolean("installed")
            branches.clear()
            runCatching { rpc(JSONObject().put("type", "git.branches").put("directory", root)) }
                .getOrNull()
                ?.optJSONObject("data")
                ?.optJSONArray("branches")
                ?.let { arr ->
                    for (i in 0 until arr.length()) {
                        val b = arr.optString(i)
                        if (b.isNotBlank()) branches.add(b)
                    }
                }
            data.optJSONArray("changed")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val f = arr.optString(i)
                    if (f.isNotBlank()) changedFiles.add(f)
                }
            }
        }
        /*
         * Fully expanded: with changes in the tree this sheet carries a file
         * list and a commit card under it, and half a screen cut the card off.
         */
        val changesSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { showChanges = false },
            sheetState = changesSheet,
            containerColor = MaterialTheme.colorScheme.background,
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("本次改动", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                    Spacer(Modifier.width(8.dp))
                    /*
                     * The branch's own picker rather than a bare list: search, a
                     * new branch, the dirty-tree question, and the four ways a
                     * checkout can come back.
                     */
                    if (changeBranch.isNotBlank()) {
                        BranchPicker(
                            current = changeBranch,
                            branches = branches.toList(),
                            checkoutBranch = { branch, force, create ->
                                runCatching {
                                    rpc(
                                        JSONObject()
                                            .put("type", "git.checkout")
                                            .put("directory", root)
                                            .put("branch", branch)
                                            .put("force", force)
                                            .put("create", create),
                                    )
                                }.getOrNull()?.optJSONObject("data")
                            },
                            onSwitched = { changeBranch = it },
                            onMessage = { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                if (changedFiles.isEmpty()) {
                    Text(
                        when {
                            changesNoGit -> "这台电脑上没有 git"
                            changesNoRepo -> "这个文件夹不是 git 仓库"
                            else -> "没有未提交的改动"
                        },
                        fontSize = 13.sp,
                        color = LocalMuted.current,
                    )
                } else {
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp)) {
                        items(changedFiles.size) { i ->
                            val file = changedFiles[i]
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        scope.launch {
                                            val r = runCatching {
                                                rpc(JSONObject().put("type", "git.diff").put("directory", root).put("file", file))
                                            }.getOrNull() ?: return@launch
                                            changePatch = file to (r.optJSONObject("data")?.optString("patch").orEmpty())
                                        }
                                    }
                                    .padding(vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    file,
                                    fontSize = 13.sp,
                                    color = LocalText.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(14.dp))
                            }
                        }
                    }
                }
                /*
                 * Committing, which the desktop's changes rail has and the phone
                 * did not: `git.commitMessage` writes the message (the model's,
                 * over the fallback), and `git.commit` takes it. A phone that can
                 * read the diff but not close it out is half the rail.
                 */
                if (changedFiles.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    val message = commitMessage
                    OutlinedTextField(
                        message,
                        { commitMessage = it },
                        Modifier.fillMaxWidth(),
                        placeholder = { Text("提交说明", fontSize = 13.sp, color = LocalMuted.current) },
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
                        maxLines = 3,
                        shape = RoundedCornerShape(10.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        if (commitBusy) {
                            androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = LocalMuted.current)
                            Spacer(Modifier.width(8.dp))
                        }
                        TextButton(
                            {
                                commitBusy = true
                                scope.launch {
                                    val written = runCatching {
                                        rpc(
                                            JSONObject().put("type", "git.commitMessage").put("directory", root)
                                                .put("paths", org.json.JSONArray(changedFiles.toList())),
                                            60_000,
                                        )
                                    }.getOrNull()?.optJSONObject("data")?.optString("message").orEmpty()
                                    if (written.isNotBlank()) {
                                        commitMessage = written
                                        withContext(Dispatchers.Main) { Toast.makeText(context, "已生成提交说明", Toast.LENGTH_SHORT).show() }
                                    } else {
                                        withContext(Dispatchers.Main) { Toast.makeText(context, "没能生成提交说明", Toast.LENGTH_SHORT).show() }
                                    }
                                    withContext(Dispatchers.Main) { commitBusy = false }
                                }
                            },
                            enabled = !commitBusy,
                        ) { Text("生成说明") }
                        Spacer(Modifier.weight(1f))
                        Surface(
                            shape = RoundedCornerShape(18.dp),
                            color = LocalText.current,
                            modifier = Modifier.clickable(enabled = !commitBusy && commitMessage.isNotBlank() && changedFiles.isNotEmpty()) {
                                commitBusy = true
                                scope.launch {
                                    val res = runCatching {
                                        rpc(
                                            JSONObject().put("type", "git.commit").put("directory", root)
                                                .put("message", commitMessage.trim())
                                                .put("includeUnstaged", true),
                                            60_000,
                                        )
                                    }.getOrNull()
                                    val ok = res?.optJSONObject("data")?.optBoolean("ok") == true
                                    val hash = res?.optJSONObject("data")?.optString("hash").orEmpty()
                                    withContext(Dispatchers.Main) {
                                        commitBusy = false
                                        if (ok) {
                                            Toast.makeText(context, "已提交 ${hash.take(8)}", Toast.LENGTH_SHORT).show()
                                            changedFiles.clear()
                                            commitMessage = ""
                                        } else {
                                            Toast.makeText(context, res?.optJSONObject("data")?.optString("error").orEmpty().ifBlank { "提交失败" }, Toast.LENGTH_LONG).show()
                                        }
                                    }
                                }
                            },
                        ) {
                            Text("提交", fontSize = 14.sp, color = LocalBg.current, modifier = Modifier.padding(horizontal = 18.dp, vertical = 9.dp))
                        }
                    }
                }
            }
        }
    }

    /*
     * The patch itself, in its own sheet for the same reason the file preview
     * is: a bottom sheet measures once, and content added later is clipped.
     * Added lines are green and removed red, as the desktop colours them.
     */
    changePatch?.let { (file, patch) ->
        ModalBottomSheet(onDismissRequest = { changePatch = null }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 25.dp)) {
                Text(file, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = LocalText.current, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                LazyColumn(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 520.dp)
                        .background(LocalPill.current, RoundedCornerShape(10.dp))
                        .padding(10.dp),
                ) {
                    val lines = patch.lineSequence().take(400).toList()
                    items(lines.size) { i ->
                        val line = lines[i]
                        val tint = when {
                            line.startsWith("+") && !line.startsWith("+++") -> Color(0xFF2E7D32)
                            line.startsWith("-") && !line.startsWith("---") -> Color(0xFFC62828)
                            else -> LocalText.current
                        }
                        Text(
                            line.ifEmpty { " " },
                            fontSize = 10.5.sp,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            color = tint,
                            softWrap = true,
                        )
                    }
                }
            }
        }
    }

    /*
     * A file opens in its own sheet rather than at the bottom of the folder
     * list: a bottom sheet measures its height when it opens, so the preview
     * added later was clipped away. This is also how the desktop shows one -
     * a reading surface of its own.
     */
    filePreview?.let { (name, body) ->
    /*
     * 模型服务: which provider serves this conversation, and its key.
     *
     * 「检查 API 密钥」 under a failed turn set `showProviders`, and nothing read
     * it - the row led nowhere, which is the one thing a repair button must not
     * do. This is what it should have opened: the providers the desktop's
     * settings page lists, whether each has a key, and a field to paste one.
     *
     * `provider.auth` is the call that matters. It writes through the
     * credentials store into `credentials.json`, which is where the backend
     * reads a key from; writing `customProviders[].apiKey` in the config - the
     * tempting shortcut - leaves a key that looks saved and never works.
     */
    if (showProviders) {
        var keyDraft by remember { mutableStateOf("") }
        var keyFor by remember { mutableStateOf("") }
        var busyKey by remember { mutableStateOf(false) }
        ModalBottomSheet(onDismissRequest = { showProviders = false; keyFor = "" }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
                Text("模型服务", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                Text(
                    "这一轮用到的密钥，在这里替换。",
                    fontSize = 12.sp,
                    color = LocalMuted.current,
                    modifier = Modifier.padding(top = 2.dp, bottom = 10.dp),
                )
                if (providers.isEmpty()) {
                    Text("还没有可用的服务", fontSize = 13.sp, color = LocalMuted.current)
                }
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                    items(providers.size) { index ->
                        val provider = providers[index]
                        val id = provider.optString("id")
                        val name = provider.optString("name", id)
                        val configured = provider.optBoolean("configured")
                        val signedIn = provider.optBoolean("authenticated")
                        val editing = keyFor == id
                        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        when {
                                            signedIn -> "已登录"
                                            configured -> "已配置密钥"
                                            else -> "未配置密钥"
                                        },
                                        fontSize = 11.sp,
                                        color = if (configured || signedIn) LocalMuted.current else MaterialTheme.colorScheme.error,
                                    )
                                }
                                Surface(
                                    shape = RoundedCornerShape(14.dp),
                                    color = LocalPill.current,
                                    modifier = Modifier.clickable {
                                        keyFor = if (editing) "" else id
                                        keyDraft = ""
                                    },
                                ) {
                                    Text(
                                        if (editing) "取消" else if (configured) "替换密钥" else "填入密钥",
                                        fontSize = 12.sp,
                                        color = LocalText.current,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                    )
                                }
                            }
                            if (editing) {
                                Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    OutlinedTextField(
                                        keyDraft, { keyDraft = it },
                                        Modifier.weight(1f),
                                        placeholder = { Text("粘贴 API 密钥", fontSize = 12.sp, color = LocalMuted.current) },
                                        shape = RoundedCornerShape(10.dp),
                                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp),
                                        singleLine = true,
                                        colors = OutlinedTextFieldDefaults.colors(
                                            unfocusedContainerColor = LocalField.current,
                                            focusedContainerColor = LocalField.current,
                                            unfocusedBorderColor = LocalFieldLine.current,
                                            focusedBorderColor = LocalFieldLine.current,
                                        ),
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    TextButton(
                                        enabled = keyDraft.isNotBlank() && !busyKey,
                                        onClick = {
                                            val key = keyDraft.trim()
                                            busyKey = true
                                            scope.launch {
                                                val reply = runCatching {
                                                    rpc(JSONObject().put("type", "provider.auth").put("provider", id).put("apiKey", key))
                                                }.getOrNull()
                                                busyKey = false
                                                val fresh = reply?.optJSONObject("data")?.optJSONArray("providers")?.let { arr ->
                                                    (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                                                }
                                                if (fresh != null) {
                                                    providers = fresh
                                                    keyFor = ""
                                                    keyDraft = ""
                                                    Toast.makeText(context, "$name 的密钥已保存", Toast.LENGTH_SHORT).show()
                                                } else {
                                                    Toast.makeText(context, "密钥没有保存成功", Toast.LENGTH_LONG).show()
                                                }
                                            }
                                        },
                                    ) { Text(if (busyKey) "保存中…" else "保存", fontSize = 13.sp) }
                                }
                            }
                        }
                        if (index != providers.lastIndex) HorizontalDivider(color = LocalMuted.current.copy(alpha = 0.12f))
                    }
                }
            }
        }
    }

        ModalBottomSheet(onDismissRequest = { filePreview = null }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 25.dp)) {
                Text(name, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = LocalText.current, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                LazyColumn(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 520.dp)
                        .background(LocalPill.current, RoundedCornerShape(10.dp))
                        .padding(10.dp),
                ) {
                    val lines = body.lineSequence().take(300).toList()
                    items(lines.size) { i ->
                        Text(
                            lines[i].ifEmpty { " " },
                            fontSize = 11.sp,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            color = LocalText.current,
                            softWrap = true,
                        )
                    }
                }
            }
        }
    }

    /*
     * The video, played from the copy the gateway sent over. `VideoView`
     * rather than ExoPlayer: the formats that arrive here are the ones every
     * Android build decodes (mp4/m4v/webm), and MediaController's transport is
     * what the desktop's own bar offers - play, seek, the clock.
     */
    officePreview?.let { (name, kind, html) ->
        OfficeViewer(name = name, kind = kind, html = html, onClose = { officePreview = null })
    }

    pdfPreview?.let { (name, file) ->
        PdfViewer(name = name, file = file, onClose = { pdfPreview = null })
    }

    videoPreview?.let { (name, file) ->
        ModalBottomSheet(onDismissRequest = { videoPreview = null }, containerColor = Color.Black) {
            Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
                Text(
                    name,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 20.dp).padding(bottom = 10.dp),
                )
                androidx.compose.ui.viewinterop.AndroidView(
                    factory = { ctx ->
                        android.widget.VideoView(ctx).apply {
                            setMediaController(android.widget.MediaController(ctx))
                            setVideoPath(file.absolutePath)
                            start()
                        }
                    },
                    modifier = Modifier.fillMaxWidth().height(320.dp),
                )
            }
        }
    }

    /* ---- 功能面板：任务 / 项目 / 定时任务 / 会话长按 / 重命名 ---- */
    /*
     * 模型服务: which provider serves this conversation, and its key.
     *
     * The desktop keeps this in its settings; the phone's connection sheet only
     * had the gateway's address. A key that has expired is the single most
     * common reason a turn fails here - it arrives as a sentence in the
     * transcript and nothing else - so the screen that repairs it belongs on
     * the phone too. `provider.auth` writes through the credentials store and
     * into `credentials.json` sealed by safeStorage, which is where the backend
     * actually reads it from; writing `customProviders[].apiKey` in the config
     * is the trap this avoids.
     */
    sheetTarget?.let { row ->
        ModalBottomSheet(onDismissRequest = { sheetTarget = null }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
                Text(row.title, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth().clickable { renameTarget = row; sheetTarget = null }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Edit, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("重命名", fontSize = 15.sp, color = LocalText.current)
                }
                Row(Modifier.fillMaxWidth().clickable {
                    request(JSONObject().put("type", "session.compact").put("sessionID", row.id)); sheetTarget = null
                }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Checklist, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("压缩对话", fontSize = 15.sp, color = LocalText.current)
                }
                Row(Modifier.fillMaxWidth().clickable {
                    request(JSONObject().put("type", "session.undo").put("sessionID", row.id)); sheetTarget = null
                }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Filled.Undo, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("撤销上一步", fontSize = 15.sp, color = LocalText.current)
                }
                Row(Modifier.fillMaxWidth().clickable {
                    request(JSONObject().put("type", "session.archive").put("sessionID", row.id).put("archived", true)); sheetTarget = null
                }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Folder, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("归档", fontSize = 15.sp, color = LocalText.current)
                }
                Row(Modifier.fillMaxWidth().clickable {
                    // The desktop's 复制为 Markdown: a heading and each turn
                    // behind 我： / MCode：, nothing else.
                    val body = buildString {
                        append("# ").append(row.title.ifBlank { "对话" }).append("\n\n")
                        for (entry in items) {
                            if (entry is Item.Msg && entry.text.isNotBlank()) {
                                append(if (entry.role == "user") "我：" else "MCode：")
                                append(entry.text.trim()).append("\n\n")
                            }
                        }
                    }.trimEnd()
                    val board = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    board.setPrimaryClip(android.content.ClipData.newPlainText("MCode", body))
                    Toast.makeText(context, "已复制对话", Toast.LENGTH_SHORT).show()
                    sheetTarget = null
                }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.ContentCopy, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("复制对话", fontSize = 15.sp, color = LocalText.current)
                }
                Row(Modifier.fillMaxWidth().clickable { deleteTarget = row; sheetTarget = null }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.DeleteOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("删除…", fontSize = 15.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
    /*
     * A turn's long press: copy its words, or branch the conversation from
     * here the way the desktop's 从此处分支 does - the same session.fork with
     * this message as the cut, so the new conversation carries everything up
     * to and including it.
     */
    messageTarget?.let { msg ->
        ModalBottomSheet(onDismissRequest = { messageTarget = null }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
                Text(msg.text.take(80), fontSize = 13.sp, color = LocalMuted.current, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth().clickable {
                    val board = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    board.setPrimaryClip(android.content.ClipData.newPlainText("MCode", msg.text))
                    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                    messageTarget = null
                }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.ContentCopy, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("复制", fontSize = 15.sp, color = LocalText.current)
                }
                /*
                 * 编辑并重发 belongs only on the reader's own words: editing a
                 * reply would be asking the model to say something it did not.
                 */
                if (msg.role == "user" && msg.text.isNotBlank()) {
                    Row(Modifier.fillMaxWidth().clickable {
                        messageTarget = null
                        editTarget = msg
                    }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Edit, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(14.dp))
                        Text("编辑并重发", fontSize = 15.sp, color = LocalText.current)
                    }
                }
                Row(Modifier.fillMaxWidth().clickable {
                    val sid = currentSession
                    val mid = msg.id
                    messageTarget = null
                    if (sid != null && mid.isNotBlank()) {
                        scope.launch {
                            try {
                                val reply = rpc(
                                    JSONObject().put("type", "session.fork")
                                        .put("sessionID", sid)
                                        .put("messageID", mid)
                                        .put("titleSuffix", true),
                                )
                                val newID = reply.optJSONObject("data")?.optJSONObject("session")?.optString("id").orEmpty()
                                if (newID.isNotBlank()) {
                                    select(newID)
                                    Toast.makeText(context, "已从此处创建分支", Toast.LENGTH_SHORT).show()
                                }
                            } catch (e: Exception) {
                                Toast.makeText(context, "分支失败：${e.message?.take(40) ?: ""}", Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Outlined.CallSplit, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("从此处分支", fontSize = 15.sp, color = LocalText.current)
                }
            }
        }
    }
    /*
     * 编辑并重发, the desktop's own pair of actions on a user turn (`sendEdit`):
     * the messages from that question on are deleted - with `files: false`, so
     * no file on disk moves - and the words come back into the box to be
     * rewritten.
     *
     * The phone could only copy a question or branch from it, which left a typo
     * at the top of a long conversation unfixable without starting again.
     */
    editTarget?.let { msg ->
        var draft by remember(msg.id) { mutableStateOf(msg.text) }
        AlertDialog(
            onDismissRequest = { editTarget = null },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = LocalText.current,
            textContentColor = LocalText.current,
            title = { Text("编辑这条消息", fontSize = 16.sp) },
            text = {
                Column {
                    Text(
                        "从这条起的内容会被删除，然后按新的文字重新发送。",
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                        color = LocalMuted.current,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                    OutlinedTextField(
                        draft,
                        { draft = it },
                        Modifier.fillMaxWidth(),
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                        shape = RoundedCornerShape(10.dp),
                        maxLines = 6,
                    )
                }
            },
            confirmButton = {
                TextButton({
                    val sid = currentSession
                    val text = draft.trim()
                    editTarget = null
                    if (sid != null && text.isNotBlank()) {
                        scope.launch {
                            val cut = runCatching {
                                rpc(
                                    JSONObject().put("type", "session.revert")
                                        .put("sessionID", sid)
                                        .put("messageID", msg.id)
                                        .put("files", false),
                                )
                            }.getOrNull()
                            if (cut == null) {
                                Toast.makeText(context, "没能撤回，请重试", Toast.LENGTH_SHORT).show()
                                return@launch
                            }
                            // The list is rebuilt from the server's own answer rather
                            // than sliced here: a revert also rewinds the cursor, and
                            // guessing at it left the cut turn on screen.
                            select(sid)
                            runCatching {
                                rpc(
                                    JSONObject().put("type", "session.prompt")
                                        .put("sessionID", sid)
                                        .put("text", text)
                                        .put("attachments", org.json.JSONArray()),
                                )
                            }
                        }
                    }
                }) { Text("发送", color = MaterialTheme.colorScheme.primary) }
            },
            dismissButton = { TextButton({ editTarget = null }) { Text("取消", color = LocalText.current) } },
        )
    }
    deleteTarget?.let { row ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = LocalText.current,
            textContentColor = LocalText.current,
            title = { Text("删除会话？") },
            text = { Text("「${row.title}」及其对话记录将被永久移除。") },
            confirmButton = {
                TextButton({
                    request(JSONObject().put("type", "session.delete").put("sessionID", row.id))
                    deleteTarget = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton({ deleteTarget = null }) { Text("取消") } },
        )
    }
    renameTarget?.let { row ->
        var newTitle by remember(row.id) { mutableStateOf(row.title) }
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = LocalText.current,
            textContentColor = LocalText.current,
            title = { Text("重命名会话") },
            text = { OutlinedTextField(newTitle, { newTitle = it }, singleLine = true) },
            confirmButton = {
                TextButton({
                    if (newTitle.isNotBlank()) request(JSONObject().put("type", "session.rename").put("sessionID", row.id).put("title", newTitle.trim()))
                    renameTarget = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton({ renameTarget = null }) { Text("取消") } },
        )
    }

    /*
     * 追求目标: rewriting an answered goal. The desktop edits the bar's line in
     * place; a phone's soft keyboard over a single-line bar would hide the text
     * being corrected, so it is a dialog.
     */
    goalEdit?.let { opening ->
        var draft by remember(opening) { mutableStateOf(opening) }
        AlertDialog(
            onDismissRequest = { goalEdit = null },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = LocalText.current,
            textContentColor = LocalText.current,
            title = { Text("编辑目标", fontSize = 16.sp) },
            text = {
                OutlinedTextField(
                    draft,
                    { draft = it },
                    Modifier.fillMaxWidth(),
                    placeholder = { Text("目标是什么", fontSize = 13.sp, color = LocalMuted.current) },
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                    shape = RoundedCornerShape(10.dp),
                )
            },
            confirmButton = {
                TextButton({
                    val next = draft.trim()
                    if (next.isNotBlank() && currentSession != null) {
                        scope.launch {
                            runCatching {
                                rpc(JSONObject().put("type", "session.goal").put("sessionID", currentSession).put("condition", next))
                            }.onFailure {
                                withContext(Dispatchers.Main) {
                                    Toast.makeText(context, "没能保存目标", Toast.LENGTH_SHORT).show()
                                }
                            }
                        }
                    }
                    goalEdit = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton({ goalEdit = null }) { Text("取消") } },
        )
    }

    /* ---- 模型选择：每个可用 provider 一节，逐行切 session.model ---- */
    /* ---- 用量：30 天总计、按天、按模型（对齐桌面设置里的用量页） ---- */
    if (modelPicker) {
        /*
         * Fully expanded: the settings are longer than half a screen once the
         * model list is in, and a half-height sheet put the last providers
         * below the fold with no way to reach them - Material's sheet scrolls
         * only its own content, and this one is a plain Column.
         */
        val settingsSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { modelPicker = false },
            sheetState = settingsSheet,
            containerColor = MaterialTheme.colorScheme.background,
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp)
                    .padding(bottom = 32.dp),
            ) {
                Text("会话设置", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                Spacer(Modifier.height(10.dp))
                // ---- Agent: build / plan ----
                val rowNow = sessions.find { it.id == currentSession }
                Text("Agent", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 8.dp, bottom = 2.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (agent in listOf("build", "plan")) {
                        val active = rowNow?.agent == agent
                        Surface(
                            shape = RoundedCornerShape(15.dp),
                            color = if (active) MaterialTheme.colorScheme.primary else LocalPill.current,
                            modifier = Modifier.clickable(enabled = currentSession != null) {
                                currentSession?.let { sid ->
                                    scope.launch { runCatching { rpc(JSONObject().put("type", "session.agent").put("sessionID", sid).put("agent", agent)) } }
                                }
                            },
                        ) {
                            Text(agent, fontSize = 14.sp, color = if (active) LocalBg.current else LocalText.current, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                        }
                    }
                }
                // ---- 权限级别: the desktop's access pill, ask / auto / full ----
                /*
                 * The one setting that decides whether a turn stops to ask at
                 * all. It has been on the wire since the phone was written
                 * (`session.access`) and had no control here, so a phone could
                 * only answer cards the desktop's level produced.
                 */
                Text("权限", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp))
                /*
                 * Full access is offered only once settings allow it - or while
                 * it is already on, so it can be left - which is the desktop's
                 * own rule (`ACCESS_LEVELS.filter`). Offering it regardless let
                 * a phone hand out a level the app had switched off.
                 */
                val canFull = appConfig?.optBoolean("allowFullAccess") != false || accessOf(rowNow, appConfig) == "full"
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((level, word) in listOf("ask" to "每次询问", "auto" to "自动允许", "full" to "全部允许")) {
                        if (level == "full" && !canFull) continue
                        val active = accessOf(rowNow, appConfig) == level
                        Surface(
                            shape = RoundedCornerShape(15.dp),
                            color = if (active) MaterialTheme.colorScheme.primary else LocalPill.current,
                            modifier = Modifier.clickable(enabled = currentSession != null) {
                                currentSession?.let { sid ->
                                    scope.launch {
                                        runCatching { rpc(JSONObject().put("type", "session.access").put("sessionID", sid).put("access", level)) }
                                        val at2 = sessions.indexOfFirst { it.id == sid }
                                    if (at2 >= 0) sessions[at2] = sessions[at2].copy(access = level, goalMode = sessions[at2].goalMode)
                                    }
                                }
                            },
                        ) {
                            Text(word, fontSize = 13.sp, color = if (active) LocalBg.current else LocalText.current, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                        }
                    }
                }
                // ---- Effort: the reasoning dial ----
                Text("Effort", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp))
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (effort in listOf("none", "minimal", "low", "medium", "high", "xhigh", "max")) {
                        val active = rowNow?.effort == effort
                        Surface(
                            shape = RoundedCornerShape(15.dp),
                            color = if (active) MaterialTheme.colorScheme.primary else LocalPill.current,
                            modifier = Modifier.clickable(enabled = currentSession != null) {
                                currentSession?.let { sid ->
                                    scope.launch { runCatching { rpc(JSONObject().put("type", "session.effort").put("sessionID", sid).put("effort", effort)) } }
                                }
                            },
                        ) {
                            Text(effort, fontSize = 14.sp, color = if (active) LocalBg.current else LocalText.current, modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp))
                        }
                    }
                }
                // ---- 追求目标: the switch, beside the settings it shares a menu with ----
                Row(
                    Modifier.fillMaxWidth().padding(top = 14.dp).clickable(enabled = currentSession != null) {
                        val next = !goalMode
                        goalMode = next
                        currentSession?.let { sid ->
                            scope.launch { runCatching { rpc(JSONObject().put("type", "session.goalMode").put("sessionID", sid).put("on", next)) } }
                        }
                    },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("追求目标", fontSize = 14.sp, color = LocalText.current)
                        Text("持续推进，直到目标彻底达成", fontSize = 11.sp, color = LocalMuted.current)
                    }
                    GoalSwitch(goalMode)
                }
                // ---- Model ----
                Text("模型", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp))
                if (providers.isEmpty()) {
                    Text("正在读取可用模型…", fontSize = 14.sp, color = LocalMuted.current, modifier = Modifier.padding(vertical = 16.dp))
                }
                for (provider in providers.filter { it.optBoolean("configured") }) {
                    Text(provider.optString("name", provider.optString("id")), fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
                    val models = provider.optJSONArray("models") ?: continue
                    for (i in 0 until models.length()) {
                        val model = models.optJSONObject(i) ?: continue
                        val providerId = provider.optString("id")
                        val modelId = model.optString("id")
                        val label = model.optString("name", modelId)
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                currentSession?.let { sid ->
                                    scope.launch {
                                        try {
                                            rpc(JSONObject().put("type", "session.model").put("sessionID", sid).put("model", JSONObject().put("provider", providerId).put("model", modelId)))
                                            // The picker closes on the press, so without this the
                                            // pill keeps the old name until some other event
                                            // happens to refresh the row.
                                            val at = sessions.indexOfFirst { it.id == sid }
                                            if (at >= 0) sessions[at] = sessions[at].copy(model = modelId)
                                        } catch (e: Exception) {
                                            /*
                                             * The picker closes on the press, so a
                                             * refused switch left the pill showing
                                             * the model the reader thought they had
                                             * chosen - and the next turn went to the
                                             * old one with no word about it.
                                             */
                                            Toast.makeText(context, "切换模型失败：${e.message?.take(60) ?: "未知错误"}", Toast.LENGTH_LONG).show()
                                        }
                                    }
                                }
                                modelPicker = false
                            }.padding(vertical = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(label, fontSize = 15.sp, color = if (modelId == currentModel) MaterialTheme.colorScheme.primary else LocalText.current)
                        }
                    }
                }
            }
        }
    }
}

/* The welcome pane: mark, greeting, and (for a fresh screen) the input. */
@Composable
fun WelcomePane(withInput: Boolean, inputBar: @Composable () -> Unit, inputAtBottom: Boolean = false) {
    /*
     * Claude's empty pane is quiet: a small mark (112 px across at 450 dpi,
     * about 40 dp) with the greeting under it, parked above the middle rather
     * than centred. Measured off its own screenshot.
     */
    val mark = @Composable {
        // Claude's phone empty pane is its asterisk over 月光下的对话?; the
        // two-pane pane greets by name. Both are sampled from its own screens.
        if (inputAtBottom) {
            // Claude's pad empty pane carries the same asterisk its phone pane
            // does, drawn rather than a bitmap: the packaged mark is a raster
            // and read as two grey triangles at this size.
            SparkMark(Modifier.size(40.dp))
            Spacer(Modifier.height(14.dp))
            Text(greeting(), fontSize = 18.sp, fontWeight = FontWeight.Normal, color = LocalText.current)
        } else {
            SparkMark(Modifier.size(40.dp))
            Spacer(Modifier.height(16.dp))
            // Claude's phrase is 50px of glyph on the pad - 18sp, not the 44
            // this was set to after a first read of its line box (144px, which
            // is leading, not the type size).
            Text(greeting(), fontSize = 18.sp, fontWeight = FontWeight.Normal, color = LocalText.current)
        }
    }
    if (inputAtBottom) {
        /*
         * Claude's wide empty state sits in the middle of the pane, not near its
         * top: on the pad its asterisk centre is at 41% of the height and the
         * phrase at 50%, so the block reads as centred. A fixed 96dp from the
         * top put it a third of a screen too high.
         */
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            Column(
                // Claude's asterisk centres at 41% of the pane and its phrase
                // at 48%; a plain centre lands both about 150px low.
                Modifier.align(Alignment.Center).padding(bottom = 124.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) { mark() }
            if (withInput) Box(Modifier.align(Alignment.BottomCenter)) { inputBar() }
            /*
             * The language pill is gone. It was copied from Claude's own phone
             * composer, where a soft 「En」 tile floats at the right of the card
             * - but there it belongs to the keyboard the app ships, and here it
             * sat on top of the send button, inert (`clickable { }`, no
             * action), covering the one control the row exists for. The
             * desktop has no such pill at all.
             */
        }
    } else {
        /*
         * Claude's phone empty state sits above the middle, not on it: its
         * asterisk centres at 43.8% of the pane's height and the greeting at
         * 49.3%, measured off its own portrait screen. A plain centered column
         * lands both about 5% low.
         */
        Column(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(horizontal = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))
            mark()
            Spacer(Modifier.weight(1f))
            // 1.14 : 1 puts the block's own centre at 43.8% instead of 50%.
            Spacer(Modifier.weight(0.14f))
        }
    }
}

/** The twelve pages the desktop's settings dialog offers, in its order. */
enum class SetPage(val label: String) {
    General("常规"), Usage("使用情况"), Appearance("外观"), Config("配置"),
    Models("模型"), Personal("个性化"), Keys("键盘快捷键"), Mcp("MCP 服务器"),
    Environment("环境"), Lab("实验室功能"), Archive("已归档对话"), Updates("应用更新"),
}

/**
 * The settings page: the desktop's two columns - a navigation strip and the
 * page beside it.
 *
 * The phone had no settings page at all. What it called settings was a 会话设置
 * sheet (agent, access, effort, goal, model) and a 模型服务 sheet that could only
 * replace a key for a provider that already existed. Theme, both type sizes,
 * providers, MCP servers, shortcuts, usage and the archive were unreachable.
 *
 * The page is drawn as a single composable with its own switches rather than a
 * row helper taking a control lambda: `SetRow` with a `@Composable () -> Unit`
 * parameter reads well but every call site then has to name the lambda, and
 * there are forty of them. The three small controls below are functions that
 * return Unit and draw themselves at their call site instead.
 */
@Composable
fun SettingsScreen(
    config: JSONObject?,
    archived: List<SessionRow>,
    usage: JSONObject?,
    providers: List<JSONObject>,
    servers: List<JSONObject>,
    onPatch: (JSONObject) -> Unit,
    onReopen: (String) -> Unit,
    onClose: () -> Unit,
) {
    var page by remember { mutableStateOf(SetPage.General) }
    val muted = LocalMuted.current
    val ink = LocalText.current
    val hairline = if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8)
    fun str(key: String, fallback: String = "") = config?.optString(key, fallback) ?: fallback
    fun num(key: String, fallback: Double = 1.0) = config?.optDouble(key, fallback) ?: fallback
    fun flag(key: String, fallback: Boolean) = config?.let { if (it.has(key)) it.optBoolean(key, fallback) else fallback } ?: fallback

    Row(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(
            Modifier.width(220.dp).fillMaxHeight()
                .windowInsetsPadding(WindowInsets.statusBars)
                .padding(vertical = 12.dp),
        ) {
            Text("设置", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = ink,
                modifier = Modifier.padding(start = 18.dp, bottom = 12.dp))
            LazyColumn(Modifier.fillMaxWidth()) {
                items(SetPage.entries.size) { index ->
                    val entry = SetPage.entries[index]
                    val active = entry == page
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (active) LocalPill.current else Color.Transparent)
                            .clickable { page = entry }
                            .padding(horizontal = 12.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(entry.label, fontSize = 14.sp,
                            fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                            color = if (active) ink else muted)
                    }
                }
            }
        }
        Box(Modifier.width(1.dp).fillMaxHeight().background(hairline))
        Column(
            Modifier.weight(1f).fillMaxHeight()
                .windowInsetsPadding(WindowInsets.statusBars)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp, vertical = 16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(page.label, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = ink,
                    modifier = Modifier.weight(1f))
                Box(Modifier.size(40.dp).clickable { onClose() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Close, contentDescription = "关闭", tint = muted, modifier = Modifier.size(18.dp))
                }
            }
            Spacer(Modifier.height(14.dp))

            when (page) {
                SetPage.General -> {
                    SetHead("基本")
                    SetLabel("语言", "界面文字与提示所用的语言。")
                    SetChoices(listOf("zh-CN" to "中文", "zh-TW" to "繁體", "en" to "English"), str("language", "zh-CN")) {
                        onPatch(JSONObject().put("language", it))
                    }
                    SetLabel("默认新建项目位置", str("projectRoot").ifBlank { "还没有设置" })
                    SetLabel("不添加可见 AI 标识", "导出的图片不加水印。")
                    SetToggle(flag("watermark", false)) { onPatch(JSONObject().put("watermark", it)) }
                }
                SetPage.Usage -> SetUsage(usage)
                SetPage.Appearance -> {
                    SetHead("主题")
                    SetLabel("主题", "跟随系统，或者固定一种。")
                    SetChoices(listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色"), str("theme", "system")) {
                        onPatch(JSONObject().put("theme", it))
                    }
                    SetHead("字体")
                    SetLabel("UI 字号", "界面上所有文字的比例。")
                    SetSteps((num("uiFontScale") * 100).toInt(), 80, 130, "%") {
                        onPatch(JSONObject().put("uiFontScale", it / 100.0))
                    }
                    SetLabel("代码字号", "代码块与终端所用的字号。")
                    SetSteps((num("codeFontScale") * 100).toInt(), 80, 130, "%") {
                        onPatch(JSONObject().put("codeFontScale", it / 100.0))
                    }
                    SetLabel("字体平滑", "更轻的笔画抗锯齿；关掉则用系统自己的。")
                    SetToggle(flag("fontSmoothing", true)) { onPatch(JSONObject().put("fontSmoothing", it)) }
                    SetHead("运动与标记")
                    SetLabel("减少动态效果", "关掉过渡与入场动画。")
                    SetChoices(listOf("system" to "跟随系统", "on" to "开", "off" to "关"), str("reduceMotion", "system")) {
                        onPatch(JSONObject().put("reduceMotion", it))
                    }
                    SetLabel("差异标记", "用底色，还是在每行开头加符号。")
                    SetChoices(listOf("color" to "底色", "signs" to "符号"), str("diffMarks", "color")) {
                        onPatch(JSONObject().put("diffMarks", it))
                    }
                }
                SetPage.Config -> {
                    SetHead("工作目录")
                    SetLabel("默认新建项目位置", str("projectRoot").ifBlank { "还没有设置" })
                    SetLabel("尊重 .gitignore", "搜索与文件列表跳过被忽略的路径。")
                    SetToggle(flag("respectGitignore", true)) { onPatch(JSONObject().put("respectGitignore", it)) }
                    SetHead("文件")
                    SetLabel("打开位置", "点一个文件时在哪里打开。")
                    SetChoices(listOf("panel" to "侧栏", "system" to "系统"), str("openTarget", "panel")) {
                        onPatch(JSONObject().put("openTarget", it))
                    }
                }
                SetPage.Models -> {
                    SetHead("供应商")
                    if (providers.isEmpty()) {
                        Text("正在读取…", fontSize = 13.sp, color = muted)
                    } else for (provider in providers) {
                        val id = provider.optString("id")
                        val ready = provider.optBoolean("configured")
                        SetLabel(
                            provider.optString("name", id),
                            provider.optString("baseURL").ifBlank { id } + (if (ready) " · 已配置" else " · 未配置"),
                        )
                        Text(
                            if (ready) "已就绪" else "缺密钥",
                            fontSize = 12.sp,
                            color = if (ready) muted else MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(bottom = 6.dp),
                        )
                    }
                    Note("在桌面端的「模型」页里增删供应商与测试连接；这里显示它们的状态。")
                }
                SetPage.Personal -> {
                    SetHead("你")
                    SetLabel("称呼", "助手在回复里如何称呼你。")
                    SetNameField(str("userName")) { onPatch(JSONObject().put("userName", it)) }
                }
                SetPage.Keys -> {
                    SetHead("快捷键")
                    for ((keys, what) in listOf(
                        "Ctrl+N" to "新建会话", "Ctrl+K" to "搜索", "Ctrl+F" to "在对话中查找",
                        "Ctrl+O" to "打开项目", "Ctrl+," to "设置", "Esc" to "关闭当前浮层",
                    )) {
                        Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(what, fontSize = 14.sp, color = ink, modifier = Modifier.weight(1f))
                            Text(keys, fontSize = 12.sp, color = muted, fontFamily = FontFamily.Monospace)
                        }
                    }
                    Note("这些键在桌面端生效；平板接键盘时同样可用。")
                }
                SetPage.Mcp -> {
                    if (servers.isEmpty()) {
                        Text("还没有配置 MCP 服务器。", fontSize = 13.sp, color = muted)
                    } else {
                        SetHead("服务器")
                        for (server in servers) {
                            val state = server.optString("state").ifBlank { server.optString("status") }
                            SetLabel(server.optString("name", server.optString("id")), server.optString("command").ifBlank { null })
                            Text(
                                when (state) {
                                    "ready", "connected" -> "已连接"
                                    "failed", "error" -> "启动失败"
                                    else -> "未启动"
                                },
                                fontSize = 12.sp,
                                color = if (state == "failed" || state == "error") MaterialTheme.colorScheme.error else muted,
                                modifier = Modifier.padding(bottom = 6.dp),
                            )
                        }
                    }
                }
                SetPage.Environment -> {
                    SetHead("运行时")
                    for ((label, value) in listOf(
                        "应用版本" to str("appVersion"),
                        "Shell" to str("shell"),
                        "终端字体" to str("terminalFont"),
                        "默认项目位置" to str("projectRoot"),
                    )) {
                        SetLabel(label, value.ifBlank { null })
                    }
                }
                SetPage.Lab -> {
                    SetHead("实验")
                    SetLabel("追求目标", "让模型持续推进，直到目标达成。")
                    SetToggle(flag("goalModeDefault", false)) { onPatch(JSONObject().put("goalModeDefault", it)) }
                    SetLabel("子智能体", "允许把一部分工作交给并行的子任务。")
                    SetToggle(flag("subagents", false)) { onPatch(JSONObject().put("subagents", it)) }
                }
                SetPage.Archive -> {
                    if (archived.isEmpty()) {
                        Text("没有已归档的对话。", fontSize = 13.sp, color = muted)
                    } else {
                        SetHead("已归档")
                        for (row in archived) {
                            SetLabel(row.title.ifBlank { row.id }, relTime(row.updated))
                            Surface(shape = RoundedCornerShape(14.dp), color = LocalPill.current,
                                modifier = Modifier.padding(bottom = 8.dp)) {
                                Text("恢复", fontSize = 12.sp, color = ink,
                                    modifier = Modifier.clickable { onReopen(row.id) }
                                        .padding(horizontal = 12.dp, vertical = 6.dp))
                            }
                        }
                    }
                }
                SetPage.Updates -> {
                    SetHead("版本")
                    SetLabel("当前版本", str("appVersion").ifBlank { "—" })
                    Note("自动更新地址尚未配置，所以这一版不会自行下载新版本。")
                }
            }
            Spacer(Modifier.height(40.dp))
        }
    }
}

/** A section heading, at the dialog's `h2`. */
@Composable
fun SetHead(text: String) {
    Text(text, fontSize = 15.sp, fontWeight = FontWeight(640), color = LocalText.current,
        modifier = Modifier.padding(top = 10.dp, bottom = 2.dp))
}

/** A row's title and its sub-line; the control, if any, goes under it. */
@Composable
fun SetLabel(title: String, sub: String? = null) {
    Text(title, fontSize = 14.sp, color = LocalText.current, modifier = Modifier.padding(top = 8.dp))
    if (!sub.isNullOrBlank()) {
        Text(sub, fontSize = 12.sp, lineHeight = 17.sp, color = LocalMuted.current,
            modifier = Modifier.padding(top = 1.dp, bottom = 6.dp))
    }
}

/** The quiet sentence a page ends on. */
@Composable
fun Note(text: String) {
    Text(text, fontSize = 12.sp, lineHeight = 18.sp, color = LocalMuted.current,
        modifier = Modifier.padding(top = 10.dp))
}

/** A two-state switch. */
@Composable
fun SetToggle(on: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        Modifier.padding(bottom = 8.dp)
            .size(width = 42.dp, height = 24.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (on) MaterialTheme.colorScheme.primary else LocalPill.current)
            .clickable { onToggle(!on) }
            .padding(2.dp),
        horizontalArrangement = if (on) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(20.dp).background(if (on) Color.White else LocalMuted.current, CircleShape))
    }
}

/** A line of choices, one selected. */
@Composable
fun SetChoices(options: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit) {
    Row(Modifier.padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((value, label) in options) {
            val active = value == selected
            Surface(shape = RoundedCornerShape(14.dp),
                color = if (active) MaterialTheme.colorScheme.primary else LocalPill.current) {
                Text(label, fontSize = 13.sp,
                    color = if (active) LocalBg.current else LocalText.current,
                    modifier = Modifier.clickable { onPick(value) }.padding(horizontal = 12.dp, vertical = 6.dp))
            }
        }
    }
}

/** A number between two bounds. */
@Composable
fun SetSteps(value: Int, min: Int, max: Int, suffix: String, onChange: (Int) -> Unit) {
    Row(Modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        for ((label, delta) in listOf("−" to -1, "+" to 1)) {
            val allowed = (value + delta) in min..max
            Box(
                Modifier.size(28.dp).clip(RoundedCornerShape(14.dp))
                    .background(if (allowed) LocalPill.current else Color.Transparent)
                    .clickable(enabled = allowed) { onChange(value + delta) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, fontSize = 15.sp,
                    color = if (allowed) LocalText.current else LocalMuted.current.copy(alpha = 0.4f))
            }
            if (delta == -1) {
                Text("$value$suffix", fontSize = 13.sp, color = LocalText.current,
                    modifier = Modifier.padding(horizontal = 10.dp))
            }
        }
    }
}

/** 使用情况: the figures the desktop's usage page shows, from `usage.summary`. */
@Composable
fun SetUsage(data: JSONObject?) {
    if (data == null) {
        Text("正在读取…", fontSize = 13.sp, color = LocalMuted.current)
        return
    }
    val total = data.optJSONObject("total") ?: JSONObject()
    SetHead("最近 30 天")
    Row(Modifier.padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
        for (label in listOf("输入", "输出", "费用")) {
            Column {
                Text(label, fontSize = 12.sp, color = LocalMuted.current)
                Text(
                    if (label == "费用") fmtCost(total, total.optInt("priced"), total.optInt("unpriced"))
                    else fmtTokens(if (label == "输入") total.optLong("input") else total.optLong("output")),
                    fontSize = 20.sp, fontWeight = FontWeight.Medium, color = LocalText.current,
                )
            }
        }
    }
    val byModel = data.optJSONArray("byModel")
    if (byModel != null && byModel.length() > 0) {
        SetHead("按模型")
        for (i in 0 until byModel.length()) {
            val row = byModel.optJSONObject(i) ?: continue
            SetLabel(row.optString("model", "—"),
                "输入 ${fmtTokens(row.optLong("input"))} · 输出 ${fmtTokens(row.optLong("output"))}")
            Text(fmtCost(row, row.optInt("priced"), row.optInt("unpriced")),
                fontSize = 12.sp, color = LocalMuted.current, modifier = Modifier.padding(bottom = 6.dp))
        }
    }
    val byDay = data.optJSONArray("byDay")
    if (byDay != null && byDay.length() > 0) {
        SetHead("按天")
        for (i in 0 until byDay.length()) {
            val row = byDay.optJSONObject(i) ?: continue
            Row(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                Text(row.optString("day", "—"), fontSize = 13.sp, color = LocalText.current, modifier = Modifier.weight(1f))
                Text(fmtCost(row, row.optInt("priced"), row.optInt("unpriced")), fontSize = 12.sp, color = LocalMuted.current)
            }
        }
    }
}

/** The reader's name, with the one button that writes it. */
@Composable
fun SetNameField(value: String, onSave: (String) -> Unit) {
    var draft by remember(value) { mutableStateOf(value) }
    Row(Modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.OutlinedTextField(
            draft, { draft = it }, Modifier.width(220.dp),
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
            shape = RoundedCornerShape(8.dp),
        )
        Spacer(Modifier.width(8.dp))
        androidx.compose.material3.TextButton({ onSave(draft.trim()) }) { Text("保存", fontSize = 13.sp) }
    }
}

/**
 * The strip a lost link puts under the header.
 *
 * The wide layout draws its own header and never calls `AppTopBar`, so the
 * notice had to be a piece both can hang under themselves - on the pad, which
 * is the only place this app runs, the bar's copy was never reached at all.
 */
@Composable
fun OfflineStrip() {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (LocalBg.current == DarkBg) Color(0xFF2A2118) else Color(0xFFFDF3E3))
            .padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.CircularProgressIndicator(
            modifier = Modifier.size(12.dp),
            strokeWidth = 1.6.dp,
            color = LocalMuted.current,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            "连接已断开，正在重连…",
            fontSize = 12.sp,
            color = if (LocalBg.current == DarkBg) Color(0xFFE8C89A) else Color(0xFF7A5B2E),
        )
    }
}

/**
 * What the server refused, under the header.
 *
 * `rpc` records the last `{ok:false, error}` it saw; before this the answer was
 * simply ignored and the screen showed an empty result, so a request the server
 * had rejected outright was indistinguishable from one that had nothing to say.
 * Tapping it dismisses; the next request replaces it.
 */
@Composable
fun ErrorStrip(message: String, onDismiss: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (LocalBg.current == DarkBg) Color(0xFF3A2222) else Color(0xFFFDECEC))
            .clickable { onDismiss() }
            .padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            message,
            fontSize = 12.sp,
            color = if (LocalBg.current == DarkBg) Color(0xFFF0A8A8) else Color(0xFF9B2C2C),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(8.dp))
        Icon(
            Icons.Filled.Close,
            contentDescription = "关闭",
            tint = if (LocalBg.current == DarkBg) Color(0xFFF0A8A8) else Color(0xFF9B2C2C),
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
fun AppTopBar(
    filterActive: Boolean,
    privacyActive: Boolean,
    onDrawer: () -> Unit,
    onFilter: () -> Unit,
    onPrivacy: () -> Unit,
    findOpen: Boolean = false,
    onFind: () -> Unit = {},
    /** False while the socket is down; the strip under the bar says so. */
    connected: Boolean = true,
) {
    /*
     * Claude's narrow header is deliberately bare: a back arrow, no title, and
     * the ghost on the right. Sampled off its own portrait screenshot - the
     * phone layout carried a hamburger, the session name and a crossed-out eye,
     * none of which Claude shows at this width.
     */
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        /*
         * `.top` is 52 tall with 18 at each end and 13 above; `.ico` inside it
         * is a 24 box with a 7 corner and a 14-18 glyph, and `brand-actions`
         * puts 8 between the marks. Material's IconButton brings a 48dp box and
         * a 24dp glyph - twice the desktop's box and half again its mark - so
         * the row drew as four large targets where the desktop has four small
         * ones. The touch targets stay 40 here (a 24dp box is not something a
         * finger can hit) but the glyphs are the desktop's sizes.
         */
        Row(
            Modifier.fillMaxWidth().height(52.dp).padding(start = 10.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Box(
                Modifier.size(40.dp).clickable { onDrawer() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.weight(1f))
            if (filterActive) {
                Box(
                    Modifier.size(40.dp).clickable { onFilter() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Tune, contentDescription = "只看运行中", tint = Ember, modifier = Modifier.size(18.dp))
                }
            }
            // Ctrl+F's magnifier, the same one the wide header carries.
            Box(
                Modifier.size(40.dp).clickable { onFind() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.Search,
                    contentDescription = if (findOpen) "关闭查找" else "在对话中查找",
                    tint = if (findOpen) Ember else LocalText.current,
                    modifier = Modifier.size(18.dp),
                )
            }
            Box(
                Modifier.size(40.dp).clickable { onPrivacy() },
                contentAlignment = Alignment.Center,
            ) {
                GhostGlyph(active = privacyActive, size = 18.dp)
            }
        }
        /*
         * A lost link says so. Without this the only symptom was a list that
         * was suddenly empty, which reads as "no conversations" rather than
         * "not connected" - and the reader had no way to tell the app was
         * already trying to come back.
         */
        if (!connected) OfflineStrip()
    }
}

/* Claude's empty state greets the operator by name: Wyatt 回来了！ */
/**
 * The little sheet ghost Claude parks in the conversation header.
 *
 * Drawn rather than iconified: the shape is a rounded dome with two eyes and a
 * scalloped hem, and no Material glyph has that silhouette. `active` tints it
 * with the accent while the privacy blur is on, which is what the eye used to
 * be for.
 */
@Composable
fun GhostGlyph(active: Boolean, size: androidx.compose.ui.unit.Dp) {
    val tint = if (active) Ember else LocalText.current
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val stroke = w * 0.10f
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.16f, h * 0.92f)
            lineTo(w * 0.16f, h * 0.42f)
            // The dome: two thirds of a circle across the top.
            cubicTo(w * 0.16f, h * 0.14f, w * 0.84f, h * 0.14f, w * 0.84f, h * 0.42f)
            lineTo(w * 0.84f, h * 0.92f)
            // Three scallops along the hem, drawn back towards the start.
            cubicTo(w * 0.72f, h * 0.80f, w * 0.66f, h * 0.80f, w * 0.62f, h * 0.92f)
            cubicTo(w * 0.56f, h * 0.80f, w * 0.50f, h * 0.80f, w * 0.46f, h * 0.92f)
            cubicTo(w * 0.40f, h * 0.80f, w * 0.34f, h * 0.80f, w * 0.30f, h * 0.92f)
            close()
        }
        drawPath(path, tint, style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
        // Two eyes.
        drawCircle(tint, radius = w * 0.055f, center = androidx.compose.ui.geometry.Offset(w * 0.36f, h * 0.50f))
        drawCircle(tint, radius = w * 0.055f, center = androidx.compose.ui.geometry.Offset(w * 0.64f, h * 0.50f))
    }
}

/**
 * Claude's empty pane greets by the hour, not by name.
 *
 * Measured off its own pad screen at 21:03: 「晚间随想」, set at roughly 48sp
 * with nothing around it. The list is the same four-character phrase per part
 * of the day that the desktop's empty pane uses.
 */
/**
 * A line under a turn that ended for a reason worth saying.
 *
 * The desktop has one for each of these (`error.detail`, the 继续 hint); on the
 * phone they were all silence, so a truncated reply and a complete one looked
 * the same.
 */
@Composable
fun TurnNote(text: String) {
    Row(
        Modifier.padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MiIcon(
            "M10 6.5v4M10 13.5v.01",
            modifier = Modifier.size(12.dp),
            viewBox = 20f,
            strokeWidth = 1.6f,
            tint = LocalMuted.current,
        )
        Spacer(Modifier.width(5.dp))
        Text(text, fontSize = 12.sp, color = LocalMuted.current, lineHeight = 17.sp)
    }
}

/**
 * `stream.loadingConvo`: 80 above and below, 13sp, in the body's grey, centred
 * (`MessageStream.vue`'s `.thread-loading`). It stands in for the empty state
 * while a conversation's history is still being read.
 */
@Composable
fun ThreadLoading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("正在加载对话…", fontSize = 13.sp, color = LocalMuted.current)
    }
}

fun greeting(): String = when (java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)) {
    in 5..8 -> "清晨随笔"
    in 9..11 -> "上午闲话"
    in 12..13 -> "午后漫谈"
    in 14..17 -> "下午絮语"
    in 18..22 -> "晚间随想"
    else -> "深夜独白"
}

fun currentSessionTitle(sessions: List<SessionRow>, current: String?): String =
    current?.let { id -> sessions.find { it.id == id }?.title } ?: "MCode"

/* ------------------------------------------------------------------ */
/* Timeline / lists                                                    */
/* ------------------------------------------------------------------ */

/**
 * A picture in a turn.
 *
 * Sent pictures travel as data URLs, so the bitmap comes from the bytes rather
 * than a file: a tap opens it full-screen on black, which is the one thing a
 * 64dp thumbnail cannot do.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ImageBox(url: String) {
    val bitmap = remember(url) {
        runCatching {
            val comma = url.indexOf(',')
            val bytes = android.util.Base64.decode(url.substring(comma + 1), android.util.Base64.DEFAULT)
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }
    var open by remember { mutableStateOf(false) }
    if (bitmap == null) return
    Image(
        bitmap.asImageBitmap(),
        contentDescription = "图片",
        contentScale = ContentScale.Crop,
        /*
         * 84dp, not 64: Claude's own thumbnail is about 235px wide on the pad,
         * which is 84dp at 400dpi, with the same 12dp corners. A 64dp square
         * read as an icon rather than as the picture that was sent.
         */
        modifier = Modifier
            .size(84.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable { open = true },
    )
    if (open) {
        androidx.compose.ui.window.Dialog(onDismissRequest = { open = false }) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color(0xB8000000))
                    .clickable { open = false },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    bitmap.asImageBitmap(),
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxWidth().padding(20.dp),
                )
            }
        }
    }
}

/**
 * A document the reader sent, drawn the way the desktop draws one.
 *
 * `sent-tile file` on the desktop is the sheet glyph and the name on a plate,
 * beside the words it was sent with. The phone had the attach chip in the
 * composer only; once sent, a document left no mark at all.
 */
@Composable
fun SentFileChip(name: String) {
    Row(
        Modifier
            .background(LocalPill.current, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.AutoMirrored.Outlined.Article,
            contentDescription = null,
            tint = LocalMuted.current,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            name.substringAfterLast('/'),
            fontSize = 13.sp,
            color = LocalText.current,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 200.dp),
        )
    }
}

/**
 * A run of consecutive tool calls, or a single one.
 *
 * Claude does not print one row per call: it prints a single call on its own,
 * and folds a run of them into one summary line - 「已运行 13 条命令, 已使用 7 个
 * 工具（1 个失败）, 读取了 4 个文件 ›」 - which opens in place. A long turn with
 * twenty calls is then one line instead of twenty, which is the difference
 * between a readable transcript and a wall.
 */
/** One file a `present_files` call handed over. */
data class DeliveredFile(val path: String, val name: String, val size: Long)

/**
 * The files a tool call handed over, from its `metadata.files`.
 *
 * Only `present_files` carries any, and only when it completed; the desktop
 * filters the same way (`deliveredFiles` in `lib/delivered.ts`) and de-duplicates
 * by path, because a turn that presents the same file twice shows it once.
 */
fun deliveredOf(part: JSONObject): List<DeliveredFile> {
    if (part.optString("name") != "present_files") return emptyList()
    val state = part.optJSONObject("state")
    val status = state?.optString("status").orEmpty().ifBlank { part.optString("status") }
    if (status.isNotEmpty() && status != "completed") return emptyList()
    val files = part.optJSONObject("metadata")?.optJSONArray("files") ?: return emptyList()
    val seen = HashSet<String>()
    val out = ArrayList<DeliveredFile>()
    for (i in 0 until files.length()) {
        val entry = files.optJSONObject(i) ?: continue
        val path = entry.optString("path")
        if (path.isBlank()) continue
        val key = path.replace('\\', '/').lowercase()
        if (!seen.add(key)) continue
        val name = entry.optString("name").ifBlank { path.substringAfterLast('/').substringAfterLast('\\') }
        out.add(DeliveredFile(path, name, entry.optLong("size", 0L)))
    }
    return out
}

data class ToolRun(val items: List<Item.Tool>, val key: String)

/** Turns the flat list into rows, folding neighbouring tool calls together. */
fun rowsOf(items: List<Item>): List<Any> {
    val out = mutableListOf<Any>()
    var run = mutableListOf<Item.Tool>()
    fun flush() {
        if (run.isEmpty()) return
        out.add(if (run.size == 1) run.first() else ToolRun(run.toList(), "run.${run.first().uid}"))
        run = mutableListOf()
    }
    for (item in items) {
        if (item is Item.Tool) run.add(item)
        else {
            flush()
            out.add(item)
        }
    }
    flush()
    return out
}

/**
 * One step of a turn: the assistant's words and the calls it made right after.
 *
 * Claude threads a rounded rule down the left of that pair - 3.6dp wide,
 * 216,216,214, capped at both ends - so a paragraph and the tool rows under it
 * read as one move rather than as loose lines. Nothing in the phone's flat list
 * said those rows belonged to the words above them.
 *
 * User turns are never wrapped: their bubble is already a block of its own.
 */
data class Step(val body: Any?, val calls: MutableList<Any>, val key: String)

/** Folds the flat rows into steps: prose plus the tool rows that follow it. */
fun stepsOf(rows: List<Any>): List<Any> {
    fun isCall(r: Any) = r is Item.Tool || r is ToolRun

    /*
     * A step is the assistant's words and the calls it made, whichever side of
     * the words they arrived on.
     *
     * The server's order varies: sometimes the calls are flushed first and the
     * prose that describes them follows, sometimes the reverse. Both belong to
     * one step, and Claude draws one rule beside the pair. Folding only forward
     * left most steps unwrapped; folding only backward left the others.
     */
    val out = mutableListOf<Any>()
    var i = 0
    while (i < rows.size) {
        val row = rows[i]
        if (isCall(row)) {
            // Calls belong to the nearest assistant prose in this stretch - the
            // paragraph they were made for, not to the user's prompt above them.
            val owner = out.indexOfLast { it is Item.Msg && it.role != "user" || it is Step }
            if (owner >= 0) {
                val existing = out[owner]
                if (existing is Step) {
                    existing.calls.add(row)
                } else if (existing is Item.Msg) {
                    out[owner] = Step(existing, mutableListOf<Any>(row), "step.${existing.id}")
                }
                i++
                continue
            }
        }
        val isAssistantProse = row is Item.Msg && row.role != "user"
        if (!isAssistantProse) {
            out.add(row)
            i++
            continue
        }
        val calls = mutableListOf<Any>()
        var j = i + 1
        while (j < rows.size && isCall(rows[j])) {
            calls.add(rows[j])
            j++
        }
        out.add(if (calls.isEmpty()) row else Step(row, calls, "step.${(row as Item.Msg).id}"))
        i = j
    }
    return out
}


/** Claude's summary of a run: what was run, how much of it broke, what was read. */
fun runSummary(run: ToolRun): String {
    val commands = run.items.count { it.name == "bash" || it.name == "exec_command" || it.name == "execute" }
    val reads = run.items.count { it.name == "read" || it.name == "list" || it.name == "grep" || it.name == "glob" }
    val writings = run.items.count { it.name == "edit" || it.name == "write" || it.name == "patch" || it.name == "apply_patch" }
    val failed = run.items.count { it.status == "error" || it.status == "failed" }
    val parts = mutableListOf<String>()
    if (commands > 0) parts.add("已运行 $commands 条命令")
    val others = run.items.size - commands - reads - writings
    if (others > 0) {
        val failedNote = if (failed > 0) "（$failed 个失败）" else ""
        parts.add("已使用 ${others + writings} 个工具$failedNote")
    } else if (writings > 0) {
        val failedNote = if (failed > 0) "（$failed 个失败）" else ""
        parts.add("已编辑 $writings 个文件$failedNote")
    }
    if (reads > 0) parts.add("读取了 $reads 个文件")
    return parts.joinToString(", ").ifBlank { "已使用 ${run.items.size} 个工具" }
}

/**
 * The branch chip and its menu, as the desktop draws them (BranchPicker.vue).
 *
 * A chip with the branch's own glyph, its name, and a caret; pressing it opens
 * a menu with a search field, the local branches (the checked one ticked), a
 * rule, then 创建并检出新分支… A new name is created and checked out in place.
 *
 * Switching is not one call. The server refuses a checkout over uncommitted
 * changes with `dirty: true` and does not say so as an error - the desktop asks
 * 「工作区有未提交改动，切到 X 会把改动一并带过去，可能产生冲突。」 and then forces
 * it. Three other answers are named individually: the branch is checked out in
 * another worktree, the name already exists, and the name is not a valid ref.
 *
 * This replaced an unnamed list inside the changes sheet, which had no search,
 * no way to make a branch, and treated a refused checkout as a success because
 * it wrote the new name into the header whatever the server said.
 */
@Composable
fun BranchPicker(
    current: String,
    branches: List<String>,
    /** `git.checkout`, handed in: this composable has no client of its own. */
    checkoutBranch: suspend (branch: String, force: Boolean, create: Boolean) -> JSONObject?,
    onSwitched: (String) -> Unit,
    onMessage: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    fun checkout(branch: String, force: Boolean = false) {
        if (branch == current && !force) {
            open = false
            return
        }
        scope.launch {
            busy = true
            val reply = checkoutBranch(branch, force, false)
            busy = false
            if (reply == null) {
                onMessage("切换分支失败")
                return@launch
            }
            when {
                reply.optBoolean("ok") -> {
                    open = false
                    onSwitched(reply.optString("branch", branch))
                    onMessage(if (reply.optBoolean("conflicts")) "分支已切换但产生了冲突，请先解决冲突" else "已切换到 $branch")
                }
                // Not an error: the tree is dirty, and the reader is asked.
                reply.optBoolean("dirty") -> {
                    open = false
                    pending = branch
                }
                reply.optJSONObject("worktree") != null -> {
                    open = false
                    onMessage("该分支已被工作树 ${reply.optJSONObject("worktree")?.optString("name").orEmpty()} 检出，请到该工作树操作")
                }
                reply.optString("code") == "branch-exists" -> onMessage("分支 $branch 已经存在")
                reply.optString("code") == "branch-invalid" -> onMessage("分支名不合法")
                else -> onMessage(reply.optString("error").ifBlank { "切换分支失败" })
            }
        }
    }

    fun create() {
        val name = draft.trim()
        if (name.isBlank()) return
        scope.launch {
            busy = true
            val reply = checkoutBranch(name, false, true)
            busy = false
            if (reply?.optBoolean("ok") == true) {
                // MiMo leaves the menu up and redraws it with the new branch
                // ticked; only the field goes.
                creating = false
                draft = ""
                onSwitched(name)
                onMessage("已创建并切换到 $name")
            } else {
                when (reply?.optString("code")) {
                    "branch-exists" -> onMessage("分支 $name 已经存在")
                    "branch-invalid" -> onMessage("分支名不合法")
                    else -> onMessage(reply?.optString("error").orEmpty().ifBlank { "创建分支失败" })
                }
            }
        }
    }

    val matches = if (query.isBlank()) branches else branches.filter { it.contains(query, ignoreCase = true) }
    // Read once for the draw scopes below: a Canvas lambda is not composable.
    val muted = LocalMuted.current
    val ink = LocalText.current

    Box {
        Row(
            Modifier
                .clip(RoundedCornerShape(15.dp))
                .background(LocalPill.current)
                .clickable { open = true }
                .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The branch's own glyph: two commits and the line that joins them.
            Canvas(Modifier.size(13.dp)) {
                val w = size.width
                val st = androidx.compose.ui.graphics.drawscope.Stroke(w * (1.2f / 16f))
                drawCircle(ink, w * (1.6f / 16f), androidx.compose.ui.geometry.Offset(w * (4.5f / 16f), w * (3.5f / 16f)), style = st)
                drawCircle(ink, w * (1.6f / 16f), androidx.compose.ui.geometry.Offset(w * (4.5f / 16f), w * (12.5f / 16f)), style = st)
                drawCircle(ink, w * (1.6f / 16f), androidx.compose.ui.geometry.Offset(w * (11.5f / 16f), w * (5.5f / 16f)), style = st)
                drawLine(ink, androidx.compose.ui.geometry.Offset(w * (4.5f / 16f), w * (5.1f / 16f) ), androidx.compose.ui.geometry.Offset(w * (4.5f / 16f), w * (10.7f / 16f)), w * (1.2f / 16f))
                drawLine(ink, androidx.compose.ui.geometry.Offset(w * (11.5f / 16f), w * (7.1f / 16f)), androidx.compose.ui.geometry.Offset(w * (6.1f / 16f), w * (11f / 16f)), w * (1.2f / 16f))
            }
            Spacer(Modifier.width(4.dp))
            Text(current.ifBlank { "分支" }, fontSize = 12.sp, color = muted, maxLines = 1)
            Canvas(Modifier.size(12.dp)) {
                val w = size.width
                val p = androidx.compose.ui.graphics.Path().apply {
                    moveTo(w * (5f / 16f), w * (6.5f / 16f))
                    lineTo(w * (8f / 16f), w * (9.5f / 16f))
                    lineTo(w * (11f / 16f), w * (6.5f / 16f))
                }
                drawPath(p, muted, style = androidx.compose.ui.graphics.drawscope.Stroke(w * (1f / 16f)))
            }
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false; creating = false; query = "" },
            modifier = Modifier.width(300.dp).background(MaterialTheme.colorScheme.surface),
        ) {
            /*
             * The search field, focused on open the way MiMo focuses it: a menu
             * of a repository's branches can run long.
             */
            val focus = remember { androidx.compose.ui.focus.FocusRequester() }
            LaunchedEffect(open) { if (open) runCatching { focus.requestFocus() } }
            OutlinedTextField(
                query, { query = it },
                Modifier.fillMaxWidth().padding(horizontal = 8.dp).focusRequester(focus),
                placeholder = { Text("搜索分支…", fontSize = 12.sp, color = LocalMuted.current) },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(14.dp)) },
                shape = RoundedCornerShape(9.dp),
                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    unfocusedContainerColor = LocalField.current,
                    focusedContainerColor = LocalField.current,
                    unfocusedBorderColor = LocalFieldLine.current,
                    focusedBorderColor = LocalFieldLine.current,
                ),
            )
            Spacer(Modifier.height(4.dp))
            Column(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState())) {
                if (branches.isEmpty()) {
                    Text("无本地分支", fontSize = 12.sp, color = LocalMuted.current, modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp))
                } else if (matches.isEmpty()) {
                    Text("无匹配的分支", fontSize = 12.sp, color = LocalMuted.current, modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp))
                }
                for ((index, branch) in matches.withIndex()) {
                    // Only the visible stretch is drawn, so a repository with a
                    // hundred branches does not build a hundred rows at once.
                    if (index < 60) Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !busy) { checkout(branch) }
                            .padding(horizontal = 12.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            branch,
                            fontSize = 13.sp,
                            color = if (branch == current) LocalText.current else LocalText.current.copy(alpha = 0.8f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if (branch == current) {
                            Canvas(Modifier.size(14.dp)) {
                                val w = size.width
                                val p = androidx.compose.ui.graphics.Path().apply {
                                    moveTo(w * (3.5f / 16f), w * (8.2f / 16f))
                                    lineTo(w * (6.4f / 16f), w * (11.1f / 16f))
                                    lineTo(w * (12.5f / 16f), w * (5f / 16f))
                                }
                                drawPath(p, ink, style = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.09f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
                            }
                        }
                    }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 4.dp), color = LocalMuted.current.copy(alpha = 0.15f))
            if (!creating) {
                Row(
                    Modifier.fillMaxWidth().clickable { creating = true }.padding(horizontal = 12.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("创建并检出新分支…", fontSize = 13.sp, color = LocalText.current)
                }
            } else {
                val field = remember { androidx.compose.ui.focus.FocusRequester() }
                LaunchedEffect(creating) { runCatching { field.requestFocus() } }
                BasicTextField(
                    draft,
                    { draft = it },
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, color = LocalText.current),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { create() }),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp).focusRequester(field),
                    decorationBox = { inner ->
                        Box {
                            if (draft.isEmpty()) Text("新分支名，回车创建", fontSize = 13.sp, color = LocalMuted.current)
                            inner()
                        }
                    },
                )
            }
        }
    }
    /*
     * The dirty tree is asked about, not forced through: the desktop's own
     * wording, and its two answers.
     */
    pending?.let { target ->
        AlertDialog(
            onDismissRequest = { pending = null },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = LocalText.current,
            textContentColor = LocalText.current,
            title = { Text("切换分支？", fontSize = 16.sp) },
            text = { Text("工作区有未提交改动，切到 $target 会把改动一并带过去，可能产生冲突。", fontSize = 14.sp, lineHeight = 22.sp) },
            confirmButton = {
                TextButton({
                    pending = null
                    checkout(target, force = true)
                }) { Text("仍然切换") }
            },
            dismissButton = { TextButton({ pending = null }) { Text("取消", color = LocalText.current) } },
        )
    }
}

/**
 * Find in the conversation, as MiMo draws it.
 *
 * The desktop's card (`FindBar.vue`): 54 above the pane's top edge and 20 in
 * from its end, a 15 unit glass, a field 180 wide, the count, previous, next and
 * close, on a 10 corner with a one-pixel weak border and a soft drop shadow. The
 * count is MiMo's own: `cur/total`, `0/0` before anything is selected, 无匹配
 * once a needle finds nothing, and `cur/total(未展开 N)` when some matches sit in
 * a fold that is not on screen - the phone draws no folds, so the last of those
 * never occurs here.
 */
@Composable
fun FindCard(
    query: String,
    onQuery: (String) -> Unit,
    count: Int,
    active: Int,
    onStep: (Int) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dark = LocalBg.current == DarkBg
    // Read outside the Canvas lambdas: a draw scope is not composable, so a
    // `Local…current` inside it compiles to a call nothing can make there.
    val ink = LocalText.current
    Row(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (dark) Color(0xFF181818) else Color(0xFFFFFEFD))
            .border(1.dp, if (dark) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The glass: a circle and its handle at a 2 unit stroke in a 24 square.
        Canvas(Modifier.size(15.dp)) {
            val w = size.width
            drawCircle(ink, radius = w * (7f / 24f), center = androidx.compose.ui.geometry.Offset(w * (11f / 24f), w * (11f / 24f)), style = androidx.compose.ui.graphics.drawscope.Stroke(w * (2f / 24f)))
            drawLine(ink, androidx.compose.ui.geometry.Offset(w * (16f / 24f), w * (16f / 24f)), androidx.compose.ui.geometry.Offset(w * (20f / 24f), w * (20f / 24f)), strokeWidth = w * (2f / 24f), cap = androidx.compose.ui.graphics.StrokeCap.Round)
        }
        Spacer(Modifier.width(6.dp))
        BasicTextField(
            value = query,
            onValueChange = onQuery,
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, color = LocalText.current),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
            modifier = Modifier.width(180.dp),
            decorationBox = { inner ->
                Box {
                    if (query.isEmpty()) Text("在对话中查找", fontSize = 13.sp, color = LocalMuted.current)
                    inner()
                }
            },
        )
        Spacer(Modifier.width(6.dp))
        Text(
            when {
                count == 0 && query.isNotBlank() -> "无匹配"
                else -> "${if (count == 0) 0 else active + 1}/$count"
            },
            fontSize = 11.sp,
            color = LocalMuted.current,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier.widthIn(min = 42.dp),
        )
        Spacer(Modifier.width(6.dp))
        // The two chevrons and the cross, each a 22 box with a 15 glyph.
        for ((glyph, enabled, action) in listOf(
            Triple("up", count > 0, { onStep(-1) }),
            Triple("down", count > 0, { onStep(1) }),
            Triple("close", true, { onClose() }),
        )) {
            Box(
                Modifier
                    .size(22.dp)
                    .clip(RoundedCornerShape(6.dp))
                    /*
                     * A drawn glyph carries no words, so the button has to name
                     * itself: without this the three controls were invisible to
                     * a screen reader and to uiautomator alike - the whole card
                     * read as a strip of pictures.
                     */
                    .semantics {
                        contentDescription = when (glyph) {
                            "up" -> "上一个"
                            "down" -> "下一个"
                            else -> "关闭查找"
                        }
                    }
                    .clickable(enabled = enabled, onClick = action),
                contentAlignment = Alignment.Center,
            ) {
                Canvas(Modifier.size(15.dp)) {
                    val w = size.width
                    val tint = ink.copy(alpha = if (enabled) 1f else 0.4f)
                    val stroke = androidx.compose.ui.graphics.drawscope.Stroke(w * (2f / 24f), cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round)
                    val p = androidx.compose.ui.graphics.Path().apply {
                        when (glyph) {
                            "up" -> { moveTo(w * (6f / 24f), w * (15f / 24f)); lineTo(w * (12f / 24f), w * (9f / 24f)); lineTo(w * (18f / 24f), w * (15f / 24f)) }
                            "down" -> { moveTo(w * (6f / 24f), w * (9f / 24f)); lineTo(w * (12f / 24f), w * (15f / 24f)); lineTo(w * (18f / 24f), w * (9f / 24f)) }
                            else -> { moveTo(w * (6f / 24f), w * (6f / 24f)); lineTo(w * (18f / 24f), w * (18f / 24f)); moveTo(w * (18f / 24f), w * (6f / 24f)); lineTo(w * (6f / 24f), w * (18f / 24f)) }
                        }
                    }
                    drawPath(p, tint, style = stroke)
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Timeline(
    items: List<Item>,
    modifier: Modifier,
    running: Boolean = false,
    onPerm: (String, String) -> Unit = { _, _ -> },
    onPermReason: (String, String) -> Unit = { _, _ -> },
    onAnswer: (String, List<String>) -> Unit = { _, _ -> },
    onMessage: (Item.Msg) -> Unit = {},
    toTop: Int = 0,
    onFixKey: () -> Unit = {},
    /** The needle being looked for; empty means no search is open. */
    find: String = "",
    /** Which match is the current one, counting from the conversation's start. */
    findStep: Int = 0,
    /** Where a delivered file opens, and the folder that names it. */
    onOpenFile: ((String, String) -> Unit)? = null,
    root: String = "",
    /**
     * Taking a turn's files back, offered on its edited-files card.
     *
     * Handed the turn's assistant message ids, which is how the server names
     * the turn (`session.revertTurn`). Null where there is no session to act
     * on, which is also how the desktop leaves the buttons off a side
     * conversation.
     */
    onRevertTurn: ((List<String>) -> Unit)? = null,
    /** 审阅: open the turn's recorded diffs. Handed the patch to show. */
    onReviewTurn: ((String) -> Unit)? = null,
) {
    val listState = rememberLazyListState()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    // Follow new items: when a message is sent or a reply/tool event lands,
    // keep the latest content in view the way Claude does.
    //
    // The target is a zero-height trailer rather than the last row: a row that
    // is taller than the screen lands with its top at the bottom edge, and a
    // history that arrives all at once would end up showing its beginning.
    // A pending permission card counts as news even when the row count does not
    // change, which is what left an approval sitting below the fold; so does a
    // turn starting or ending, since the working line adds and removes a row.
    val pending = items.count { it is Item.Perm }
    // Consecutive tool calls are folded into one summary row before drawing, so
    // the row count is not the item count and the scroll target has to follow it.
    /*
     * Each pending card says where it sits in the queue - 1/3, 2/3 - rather than
     * always 1/N. Three requests that arrive together each showed "1/3" here,
     * which reads as one request and no progress.
     */
    val permIndex = remember(items.toList()) {
        val cards = items.filterIsInstance<Item.Perm>()
        cards.withIndex().associate { (i, card) -> card.requestId to (i + 1 to cards.size) }
    }
    /*
     * `rowsOf` walks the list it is handed. Handed the live `SnapshotStateList`
     * it walked the very list a frame could be clearing at that moment, and the
     * iterator threw `ConcurrentModificationException` inside LazyColumn's
     * interval content - which took the whole app down on 编辑并重发. The copy is
     * the list as of this composition, which is all the rows are meant to be.
     */
    val rows = remember(items.toList()) { stepsOf(rowsOf(items.toList())) }
    /*
     * Each turn's edits, and which of the drawn rows ends that turn.
     *
     * The desktop draws one card per turn, after the turn's last row
     * (`MessageStream.vue` places `EditedFilesCard` at the end of every turn).
     * The rows here are folded - a step swallows the calls under a paragraph, a
     * run swallows neighbouring calls - so the card cannot hang off the call
     * that made it: it goes under whichever folded row last covers the turn,
     * which is what `keysByRow` is for.
     */
    val edits = remember(items.toList()) { turnEdits(items.toList()) }
    val editAt = remember(rows) {
        if (edits.isEmpty()) return@remember emptyMap<Int, String>()
        val covered = keysByRow(rows)
        val out = HashMap<Int, String>()
        for ((turnKey, _) in edits) {
            val at = covered.indexOfLast { turnKey in it }
            if (at >= 0) out[at] = turnKey
        }
        out
    }
    /*
     * The turn the two glyphs belong to.
     *
     * Claude puts copy and read-aloud under the last reply only, not under every
     * one: the transcript is a history, and a pair of buttons repeating down it
     * is noise. This is the id of the newest assistant message that has words -
     * a step's body counts as one - and it moves as a turn streams.
     */
    val lastReplied = remember(rows) {
        rows.asReversed().firstNotNullOfOrNull { row ->
            when (row) {
                is Step -> (row.body as? Item.Msg)?.takeIf { it.text.isNotBlank() }?.id
                is Item.Msg -> row.takeIf { it.role != "user" && it.text.isNotBlank() }?.id
                else -> null
            }
        }
    }
    /*
     * Whether the timeline should keep following new lines.
     *
     * Claude stops following the moment the reader scrolls up - it does not
     * yank them back every time a tool row lands - and offers a round button at
     * the bottom edge to return. `follows` is set false only on a real drag
     * (a programmatic scroll raises no DragInteraction, so this cannot unluck
     * itself), and set back on when the end is reached again.
     */
    var follows by remember { mutableStateOf(true) }
    // Tapping the conversation's title scrolls back to its first line, the way
    // Claude's header does; every bump of the counter is one request.
    LaunchedEffect(toTop) {
        if (toTop > 0) {
            follows = false
            listState.animateScrollToItem(0)
        }
    }

    /*
     * The message holding the match being looked at, and which occurrence
     * inside it. Stepping to it scrolls the row into view - the desktop's
     * `scrollIntoView`, which is the whole point of a find bar in a long
     * transcript.
     */
    val hits = remember(items.toList(), find) {
        if (find.isBlank()) emptyList() else buildList {
            for ((index, item) in items.toList().withIndex()) {
                val body = when (item) {
                    is Item.Msg -> item.text
                    is Item.Tool -> item.title + " " + item.output
                    else -> ""
                }
                var at = body.indexOf(find, 0, ignoreCase = true)
                while (at >= 0) {
                    add(index)
                    at = body.indexOf(find, at + find.length, ignoreCase = true)
                }
            }
        }
    }
    val hitIndex = if (hits.isEmpty()) 0 else Math.floorMod(findStep, hits.size)
    val hitAt = hits.getOrNull(hitIndex) ?: -1
    val hitOrdinal = if (hitAt < 0) 0 else hits.take(hitIndex).count { it == hitAt }
    LaunchedEffect(find, findStep) {
        if (find.isBlank() || hitAt < 0) return@LaunchedEffect
        // The row's own place in the drawn list, which skips the working line.
        val row = rows.indexOfFirst {
            when (it) {
                is Item.Msg -> (it as Item).key == (items.getOrNull(hitAt) as? Item)?.key
                is Step -> ((it.body as? Item)?.key) == (items.getOrNull(hitAt) as? Item)?.key
                else -> false
            }
        }
        if (row >= 0) {
            follows = false
            listState.animateScrollToItem(row)
        }
    }
    val atEnd by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull() ?: return@derivedStateOf true
            last.index >= info.totalItemsCount - 1
        }
    }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is androidx.compose.foundation.interaction.DragInteraction.Start) follows = false
        }
    }
    LaunchedEffect(atEnd) { if (atEnd) follows = true }
    /*
     * Sending your own message always returns to the end, even after reading
     * back: Claude does the same, and without it a prompt typed while scrolled
     * up disappeared below the fold with only the working line in sight.
     */
    val myTurns = items.count { it is Item.Msg && it.role == "user" }
    LaunchedEffect(myTurns) { if (myTurns > 0) follows = true }
    LaunchedEffect(rows.size, pending, running, follows) {
        val last = rows.size + if (running) 0 else -1
        if (last >= 0 && follows) listState.animateScrollToItem(last)
    }
    // A running turn gets one more row: Claude keeps a working line under the
    // last thing said, so the page does not look finished while it is not.
    Box(modifier) {
    /*
     * The needle reaches every `Text` under this pane through the local, the
     * way the desktop's highlight registry reaches every text node. The
     * ordinal is per message, so the highlight inside a line can tell whether
     * it holds the match being stepped to.
     */
    androidx.compose.runtime.CompositionLocalProvider(
        LocalFind provides if (find.isBlank()) null else FindNeedle(find, hitOrdinal),
    ) {
    /*
     * MiMo's reading column: 764 wide with 28 each side (`.inner` in
     * MessageStream.vue), centred, so on a wide pane the text keeps the same
     * measure it has on the desktop rather than running the full 3408. It was
     * 12 either side with no cap, which on this pad drew lines some 2.5x the
     * desktop's length - the single largest difference in the transcript.
     */
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().widthIn(max = 812.dp).align(Alignment.Center),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        // The first turn used to sit flush against the header and read as
        // clipped; Claude leaves a breath of air above it.
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 28.dp, end = 28.dp, top = 10.dp, bottom = 6.dp),
    ) {
        for (rowAt in rows.indices) {
            val item = rows[rowAt]
            item(key = (item as? ToolRun)?.key ?: (item as? Step)?.key ?: (item as Item).key) {
                /*
                 * `@keyframes msg-in` (MessageStream.vue): 0.2s on
                 * `cubic-bezier(0.2, 0.7, 0.2, 1)`, rising 8 from below as it
                 * fades in. The phone used Compose's default easing over 180ms,
                 * which starts slower and settles harder - the same travel, a
                 * different feel, and this is the motion a reader watches most.
                 */
                var shown by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) { shown = true }
                val appear by animateFloatAsState(
                    if (shown) 1f else 0f,
                    tween(durationMillis = 200, easing = CubicBezierEasing(0.2f, 0.7f, 0.2f, 1f)),
                    label = "row-in",
                )
                /*
                 * A Column, not a Box: the row can carry a second child - the
                 * turn's edited-files card that hangs under its last row - and
                 * a Box stacks its children on top of each other, so the card
                 * was drawn over the paragraph it was meant to follow. Measured
                 * on the pad: 「起更新了。」 sat behind the card's top edge.
                 */
                Column(Modifier.graphicsLayer { alpha = appear; translationY = (1f - appear) * 8.dp.toPx() }) {
                when (item) {
                    /*
                     * A step: the rule down the left, then the words and the
                     * calls it made inside it. The rule is the only thing that
                     * says those rows belong together.
                     */
                    /*
                     * `IntrinsicSize.Min` is what lets the rule stretch: in a Row
                     * whose children size themselves, `fillMaxHeight` has no
                     * height to fill - the bar collapsed to nothing and the step
                     * looked exactly like a bare reply.
                     */
                    is Step -> {
                        /*
                         * The rule is drawn behind the content, not beside it:
                         * a Box in a Row sizes to its own content, and a rule
                         * with no content of its own measured zero - which is
                         * why the first attempt showed nothing at all.
                         */
                        val rail = if (LocalBg.current == DarkBg) Color(0xFF3A3A38) else Color(0xFFD8D8D6)
                        Box(Modifier.fillMaxWidth()) {
                            Canvas(Modifier.matchParentSize()) {
                                val x = 1.8.dp.toPx()
                                drawLine(
                                    color = rail,
                                    start = androidx.compose.ui.geometry.Offset(x, 4.dp.toPx()),
                                    end = androidx.compose.ui.geometry.Offset(x, size.height - 4.dp.toPx()),
                                    strokeWidth = 3.5.dp.toPx(),
                                    cap = androidx.compose.ui.graphics.StrokeCap.Round,
                                )
                            }
                            Column(Modifier.fillMaxWidth().padding(start = 14.dp)) {
                                (item.body as? Item.Msg)?.let { StepBody(it) }
                                for (call in item.calls) {
                                    when (call) {
                                        is Item.Tool -> ToolRow(call)
                                        is ToolRun -> RunRow(call)
                                    }
                                }
                            }
                        }
                    }
                    is Item.Msg -> {
                        val isUser = item.role == "user"
                        Box(Modifier.fillMaxWidth()) {
                            Column(
                                Modifier
                                    /*
                                     * Claude leaves the reader's own turn clear of
                                     * the pane's right edge - 260px on the pad,
                                     * where this ran to within 30. The cap keeps
                                     * a long prompt from becoming a wall, and the
                                     * inset keeps the bubble off the frame.
                                     */
                                    .then(
                                        if (isUser) Modifier
                                            .align(Alignment.CenterEnd)
                                            /*
                                             * Claude's bubble hugs its words and
                                             * only grows when they need room; a
                                             * fixed share of the pane turned
                                             * "hello" into a full-width slab. The
                                             * cap is a maximum, not a width.
                                             */
                                            // `.user-bubble` is 78% of the reading
                                            // column, not a fixed width: on a wide
                                            // pane a hard 560 left the bubble short
                                            // of the cap MiMo draws it to.
                                            .fillMaxWidth(0.78f)
                                        else Modifier.fillMaxWidth()
                                    )
                                    // Claude renders assistant turns straight on the
                                    // page - only user turns get a bubble.
                                    /*
                                     * `.user-bubble`: a 16px corner and 9/13 of
                                     * inset, which is MiMo's own measurement -
                                     * this carried 12 and 10/10, a tighter pill
                                     * that made a two-word question look like a
                                     * chip. The assistant keeps its 5 above and
                                     * below and loses the side inset the bubble
                                     * needed.
                                     */
                                    .background(
                                        if (isUser) LocalBubble.current else Color.Transparent,
                                        RoundedCornerShape(if (isUser) 16.dp else 0.dp),
                                    )
                                    .padding(
                                        start = if (isUser) 13.dp else 0.dp,
                                        end = if (isUser) 13.dp else 0.dp,
                                        top = if (isUser) 9.dp else 5.dp,
                                        bottom = if (isUser) 9.dp else 5.dp,
                                    )
                                    // Claude's turns answer a long press with
                                    // 复制 / 从此处分支; both are here now.
                                    .combinedClickable(onClick = {}, onLongClick = { onMessage(item) }),
                            ) {
                                // A picture arrives above the words it was sent
                                // with, the way the desktop draws it.
                                if (item.images.isNotEmpty()) {
                                    Row(
                                        Modifier.padding(bottom = if (item.text.isBlank()) 0.dp else 6.dp),
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        for (url in item.images.take(3)) {
                                            ImageBox(url)
                                        }
                                    }
                                }
                                /*
                                 * A document travels above the words too, as the
                                 * desktop draws it: a sheet, the file's name, and
                                 * the whole thing tappable. Without this a
                                 * question that was only a file showed an
                                 * ellipsis.
                                 */
                                if (item.files.isNotEmpty()) {
                                    Row(
                                        Modifier.padding(bottom = if (item.text.isBlank()) 0.dp else 6.dp),
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        for (name in item.files.take(3)) SentFileChip(name)
                                    }
                                }
                                // Claude sets a reply the way the desktop does:
                                // headings, real code boxes, lists. A user turn
                                // is their own words and is never parsed.
                                if (isUser) {
                                    if (item.text.isNotBlank()) Text(
                                        item.text.ifEmpty { "…" },
                                        /*
                                         * The same 17sp/26sp the reply uses, as
                                         * Claude sets them: a bubble is the same
                                         * body copy on a tinted plate, not a
                                         * smaller aside. 15sp here read as a
                                         * caption beside the 17sp it now shares
                                         * a page with.
                                         */
                                        // `.user-bubble` sets 500: the reader's
                                        // words carry the same weight they do on
                                        // the desktop's tinted plate.
                                        fontSize = 17.sp,
                                        lineHeight = 26.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = LocalBubbleText.current,
                                    )
                                    /*
                                     * A mid-turn message gets the desktop's note
                                     * under it - 「已插话 · 会尽快处理」 - because a bubble
                                     * that simply appeared inside a running turn
                                     * gave no sign whether the model had heard it
                                     * or would act on it.
                                     */
                                    if (item.steered) {
                                        Text(
                                            "已插话 · 会尽快处理",
                                            fontSize = 11.sp,
                                            color = LocalMuted.current,
                                            modifier = Modifier.align(Alignment.End).padding(top = 4.dp),
                                        )
                                    }
                                } else {
                                    if (item.text.isNotBlank()) {
                                        MarkdownBody(
                                            item.text,
                                            dark = LocalBg.current == DarkBg,
                                        )
                                    }
                                    /*
                                     * `finish` says how the turn ended, and the
                                     * values that matter are the ones where the
                                     * turn did NOT end cleanly: `max_tokens` ran
                                     * out of room mid-sentence, `refusal`
                                     * declined, `error` broke, `aborted` was
                                     * stopped. All of them used to arrive as an
                                     * ordinary reply that simply stopped - and
                                     * an `error` or `aborted` turn often carries
                                     * no text at all, so the note has to sit
                                     * outside the body's own check or it would
                                     * never draw for exactly those cases.
                                     */
                                    when {
                                        item.finish == "max_tokens" -> TurnNote("回复已达长度上限，内容被截断。发送「继续」可以让它接着说。")
                                        item.finish == "refusal" -> TurnNote("模型拒绝了这个请求。")
                                        item.finish == "error" -> TurnNote("这一轮出错了。")
                                        item.finish == "aborted" -> TurnNote("这一轮被中断。")
                                        /*
                                         * Through to the end without answering,
                                         * having thought about it: the desktop's
                                         * `thinkOnly`. Only that case gets this
                                         * line - an empty turn that never
                                         * thought is a different thing (a model
                                         * that said nothing at all).
                                         */
                                        item.text.isBlank() && item.thought > 0 ->
                                            TurnNote("这一轮只生成了思考过程，没有给出回答。")
                                        else -> Unit
                                    }
                                    /*
                                     * Claude ends a reply with two quiet glyphs -
                                     * copy, then read aloud - at 149,147,143 on
                                     * the pad, 127px wide for the pair. They were
                                     * only reachable by long-pressing the turn
                                     * here, which nothing on screen said.
                                     */
                                    val context = androidx.compose.ui.platform.LocalContext.current
                                    var copied by remember(item.id) { mutableStateOf(false) }
                                    if (item.id == lastReplied) Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Box(
                                            Modifier.size(34.dp).clickable {
                                                val board = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                                board.setPrimaryClip(android.content.ClipData.newPlainText("MCode", item.text))
                                                copied = true
                                                android.widget.Toast.makeText(context, "已复制", android.widget.Toast.LENGTH_SHORT).show()
                                            },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(
                                                Icons.Outlined.ContentCopy,
                                                contentDescription = "复制",
                                                tint = if (copied) Color(0xFF2E7D32) else LocalMuted.current,
                                                modifier = Modifier.size(16.dp),
                                            )
                                        }
                                        Box(
                                            Modifier.size(34.dp).clickable { onMessage(item) },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(
                                                Icons.Outlined.PlayArrow,
                                                contentDescription = "更多操作",
                                                tint = LocalMuted.current,
                                                modifier = Modifier.size(16.dp),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    is ToolRun -> {
                        var open by remember { mutableStateOf(false) }
                        // `.hstep`'s indent and rhythm, as ToolRow below has it.
                        Column(Modifier.padding(start = 23.dp)) {
                            Row(
                                Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                /*
                                 * Claude puts the chevron right after the words, not
                                 * at the far edge of the pane: the summary reads as
                                 * one phrase, and the glyph is part of it. A weighted
                                 * Text pushed it out to x=3350, a pane away from the
                                 * sentence it belongs to.
                                 */
                                Text(
                                    runSummary(item),
                                    fontSize = 14.sp,
                                    lineHeight = 22.4.sp,
                                    color = LocalMuted.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                Icon(
                                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                                    contentDescription = if (open) "收起" else "展开",
                                    tint = LocalMuted.current,
                                    modifier = Modifier.size(14.dp).graphicsLayer { rotationZ = if (open) 90f else 0f },
                                )
                            }
                            if (open) {
                                // The run opens in place: each call keeps the row
                                // it would have had on its own.
                                for (call in item.items) ToolRow(call)
                            }
                        }
                    }
                    is Item.Tool -> {
                        ToolRow(item, onOpenDelivered = onOpenFile, root = root)
                    }
                    is Item.Perm -> {
                        val (at, total) = permIndex[item.requestId] ?: (1 to 1)
                        PermCard(item.copy(queueTotal = total, queuePosition = at), onPerm = onPerm, onPermReason = onPermReason)
                    }
                    is Item.Quest -> QuestCard(item, onAnswer = onAnswer)
                    is Item.Gap -> GapRule(item.label)
                    is Item.Err -> {
                        // A broken turn is a card, not a red line lost in the
                        // prose: the desktop gives it its own surface and its
                        // own weight, so a failure is as visible as a reply.
                        val aboutKey = remember(item.uid) {
                            val lower = item.text.lowercase()
                            listOf("api key", "apikey", "invalid key", "unauthorized", "401", "authentication", "forbidden", "credit", "密钥", "额度", "认证")
                                .any { it in lower }
                        }
                        /*
                         * `.err-card`: the raised surface, a hairline, a 16
                         * corner, 12/14 of inset - and the card's own text
                         * colour for both the sentence and its 20px mark
                         * ("MiMo's 20px alert in the card's own text colour,
                         * not red"). The phone filled it with the error
                         * container and painted the words red, which made a
                         * failed turn look like a blocking alert in the middle
                         * of a transcript that had otherwise gone fine.
                         */
                        Column(
                            Modifier
                                .padding(start = 2.dp, top = 12.dp)
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(16.dp))
                                .border(
                                    1.dp,
                                    if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFF1F1F1),
                                    RoundedCornerShape(16.dp),
                                )
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                /*
                                 * `.err-icon`: a circled exclamation on a 20
                                 * grid - r 7.5, a 1.7 stroke, the bar from
                                 * 5.9 to 10.7 and a dot at 13.7. Not a warning
                                 * triangle: the desktop's mark is the same one
                                 * it uses for "this failed", in the card's own
                                 * ink.
                                 */
                                val errInk = LocalText.current
                                androidx.compose.foundation.Canvas(Modifier.size(20.dp)) {
                                    val k = size.width / 20f
                                    drawCircle(
                                        errInk,
                                        radius = 7.5f * k,
                                        center = androidx.compose.ui.geometry.Offset(10f * k, 10f * k),
                                        style = androidx.compose.ui.graphics.drawscope.Stroke(1.7f * k),
                                    )
                                    drawLine(
                                        errInk,
                                        androidx.compose.ui.geometry.Offset(10f * k, 5.9f * k),
                                        androidx.compose.ui.geometry.Offset(10f * k, 10.7f * k),
                                        strokeWidth = 1.7f * k,
                                        cap = StrokeCap.Round,
                                    )
                                    drawCircle(
                                        errInk,
                                        radius = 1f * k,
                                        center = androidx.compose.ui.geometry.Offset(10f * k, 13.7f * k),
                                    )
                                }
                                Spacer(Modifier.width(12.dp))
                                Text(item.text, fontSize = 14.sp, lineHeight = 23.8.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                            }
                            /*
                             * The failure the phone could name but not repair: an
                             * expired key arrives as a sentence, and the screen
                             * that fixes it was only on the desktop. The row is
                             * offered only when the words are about a key, so it
                             * is not a permanent button under every failure.
                             */
                            if (aboutKey) {
                                Spacer(Modifier.height(6.dp))
                                Row(
                                    Modifier.padding(start = 23.dp).clip(RoundedCornerShape(14.dp))
                                        .clickable { onFixKey() }
                                        .padding(horizontal = 10.dp, vertical = 5.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(Icons.Outlined.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(13.dp))
                                    Spacer(Modifier.width(5.dp))
                                    Text("检查 API 密钥", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                                }
                            }
                        }
                    }
                }
                /*
                 * The turn's edits, under its last row.
                 *
                 * Only once the turn is over: a live turn's files are still
                 * moving, and the desktop holds the card back for the same
                 * reason (`v-if="!(at === turns.length - 1 && shownBusy)"`).
                 * `reverted` reads the flag the server writes on the turn's last
                 * message when 撤销 actually moved something.
                 */
                val turnKey = editAt[rowAt]
                val turn = turnKey?.let { edits[it] }
                // The last turn's card waits while it is still streaming; an
                // earlier turn's is settled and stays.
                val settled = !running || turnKey != edits.keys.lastOrNull()
                if (turn != null && settled) {
                    EditedCard(
                        turn,
                        root,
                        onOpenFile,
                        onRevert = if (onRevertTurn != null && turn.messages.isNotEmpty()) {
                            { onRevertTurn(turn.messages) }
                        } else {
                            null
                        },
                        onReview = if (turn.patch.isBlank() || onReviewTurn == null) null else {
                            { onReviewTurn(turn.patch) }
                        },
                    )
                }
                }
            }
        }
        if (running) {
            item(key = "working") {
                /*
                 * The verb of the tool that is running, if one is: the row above
                 * already name it, and repeating "thinking" under a command that is
                 * executing is the least useful thing the line could say.
                 */
                val busy = items.filterIsInstance<Item.Tool>().lastOrNull { it.status == "running" }
                WorkingLine(if (busy != null) toolVerbOf(busy.name, "running") + "…" else "思考中…")
            }
        }
        /*
         * Claude's other foot-of-transcript line: 「N 个运行中的任务」 in its link
         * blue, a count of the side work the turn has running. The protocol has
         * no such number - a task is a tool call's own registry, not a session
         * field - so this counts what the transcript can see: tool calls still
         * marked running. It is offered only when there is one, and reads the
         * same way rather than inventing a total.
         */
        val liveCalls = items.filterIsInstance<Item.Tool>().count { it.status == "running" }
        if (liveCalls > 0) {
            item(key = "tasks") {
                Row(
                    Modifier.fillMaxWidth().clickable { }.padding(start = 10.dp, top = 4.dp, bottom = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "$liveCalls 个运行中的任务",
                        fontSize = 13.sp,
                        color = if (LocalBg.current == DarkBg) Color(0xFF7FA8E8) else Color(0xFF4A6FA5),
                    )
                }
            }
        }
        // The scroll target (see the LaunchedEffect above).
        item(key = "__bottom") { Box(Modifier.height(0.dp)) }
    }
    /*
     * Claude's way back: a 43dp white disc at the foot of the pane with the ink
     * arrow in it, shown only while the reader is above the end. It sits just
     * over the last line, so a turn arriving while someone reads back does not
     * hide underneath it.
     */
    /*
     * The disc floats over the transcript, so it must not sit on top of the
     * one row that is waiting for the reader: a pending approval. While one is
     * on screen (a card, or its 「拒绝并说明」 field open under it) the disc is a tap
     * that might approve or explain instead of scrolling, and it covered the
     * card's own buttons. It steps aside until the queue is clear.
     */
    if (!atEnd && items.none { it is Item.Perm }) {
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 10.dp)
                .size(43.dp)
                .shadow(3.dp, CircleShape)
                .background(if (LocalBg.current == DarkBg) Color(0xFF2E2E2E) else Color(0xFFFEFEFE), CircleShape)
                .clickable {
                    follows = true
                    scope.launch { listState.animateScrollToItem(rows.size + if (running) 0 else -1) }
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Outlined.ArrowDownward,
                contentDescription = "回到底部",
                tint = LocalText.current,
                modifier = Modifier.size(17.dp),
            )
        }
    }
    }
    }
}

/**
 * Claude's working line: three dots that breathe while a turn is in flight.
 *
 * The desktop keeps a working mark under the last thing said so the page never
 * looks finished mid-turn; this is the same idea at phone size.
 */
/**
 * The wave rule Claude draws between sittings.
 *
 * Measured off its own divider on the pad: 9px tall at 400dpi (about 3dp), a
 * 183,183,181 hairline that undulates across the pane, broken in the middle for
 * the clock. A straight rule would read as a section break in a document; the
 * wave is what makes it read as time passing.
 */
/** One wavy rule: quadratic humps at the pitch measured off Claude's divider. */
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
            path.quadraticBezierTo((x + nx) / 2f, if (up) mid - amp * 2f else mid + amp * 2f, nx, mid)
            up = !up
            x = nx
        }
        drawPath(path, ink, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.5f))
    }
}

@Composable
fun GapRule(label: String) {
    val ink = if (LocalBg.current == DarkBg) Color(0xFF4A4A48) else Color(0xFFB7B7B5)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaveLine(ink, Modifier.weight(1f))
        Text(
            label,
            fontSize = 11.sp,
            color = LocalMuted.current,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        WaveLine(ink, Modifier.weight(1f))
    }
}

@Composable
fun WorkingLine(label: String = "思考中…") {
    val transition = rememberInfiniteTransition(label = "working")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 3f,
        animationSpec = infiniteRepeatable(tween(1200, easing = LinearEasing), RepeatMode.Restart),
        label = "phase",
    )
    /*
     * Claude's working mark is a sentence, not a row of dots: 「思考中…」 in the
     * ember tone (188,109,79 on the pad) with three dots breathing after it.
     * This used to be three grey dots alone, which said nothing about what was
     * happening.
     */
    val ink = Color(0xFFBD6F50)
    /*
     * Claude's order is dots first, then the words - 「... Deliberating…」 - not
     * the other way round, and the words change with what the turn is doing:
     * a tool that is running names its own verb (正在读取…), and a turn with no
     * tool says it is thinking. A fixed 「思考中」 while a command was actually
     * executing told the reader less than the row above it already did.
     */
    Row(Modifier.padding(start = 10.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until 3) {
            // Each dot is brightest when the phase passes it, which reads as a
            // wave rather than three blinking lights.
            val distance = kotlin.math.abs(((phase - i) % 3f + 3f) % 3f)
            val lift = (1f - (distance.coerceAtMost(1f))).coerceIn(0f, 1f)
            Box(
                Modifier
                    .padding(end = 3.dp)
                    .size(3.5.dp)
                    .graphicsLayer { alpha = 0.35f + 0.65f * lift; translationY = -1.5.dp.toPx() * lift }
                    .background(ink, CircleShape),
            )
        }
        Spacer(Modifier.width(9.dp))
        Text(label, fontSize = 15.sp, color = ink)
    }
}

/* 用量页：总计卡 + 按天 + 按模型，数字与桌面设置页同源（usage.summary）。 */
fun fmtTokens(n: Long): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "%.1fK".format(n / 1_000.0)
    else -> n.toString()
}

fun fmtCost(usage: JSONObject, priced: Int, unpriced: Int): String {
    if (priced == 0 && unpriced > 0) return "—"
    return "$%.2f".format(usage.optDouble("cost", 0.0))
}


/* Claude's ask card: the question, its options and a typed answer. */
@Composable
fun QuestCard(item: Item.Quest, onAnswer: (String, List<String>) -> Unit) {
    val questions = item.request.optJSONArray("questions") ?: return
    /*
     * Every question, not just the first.
     *
     * The tool sends a list - a model may ask three things at once - and this
     * card rendered `questions[0]` and dropped the rest, so a request that
     * wanted two answers could only ever be given one. `multiple` was ignored
     * for the same reason: a checkbox question behaved like a radio one.
     *
     * Answers are collected per question and sent together when the last one
     * has an answer, which is what the protocol's one `reply` carries.
     */
    val picks = remember(item.requestId) { mutableStateMapOf<Int, List<String>>() }
    var custom by remember(item.requestId) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().background(LocalPill.current, RoundedCornerShape(12.dp)).padding(12.dp)) {
        for (qi in 0 until questions.length()) {
            val q = questions.optJSONObject(qi) ?: continue
            if (qi > 0) Spacer(Modifier.height(12.dp))
            Text(q.optString("header", "问题"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = LocalText.current)
            Spacer(Modifier.height(4.dp))
            Text(q.optString("question"), fontSize = 13.sp, color = LocalText.current)
            Spacer(Modifier.height(10.dp))
            val multiple = q.optBoolean("multiple")
            val chosen = picks[qi].orEmpty()
            val opts = q.optJSONArray("options")
            if (opts != null) for (i in 0 until opts.length()) {
                val o = opts.optJSONObject(i) ?: continue
                val label = o.optString("label")
                val on = label in chosen
                Surface(
                    Modifier
                        .fillMaxWidth()
                        .padding(bottom = 6.dp)
                        .clickable {
                            if (multiple) {
                                // A checkbox question accumulates; a radio one
                                // replaces, which is how the desktop reads them.
                                picks[qi] = if (on) chosen - label else chosen + label
                            } else {
                                picks[qi] = listOf(label)
                                if (questions.length() == 1) onAnswer(item.requestId, listOf(label))
                            }
                        },
                    shape = RoundedCornerShape(8.dp),
                    color = if (on) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.surfaceVariant,
                    border = if (on) androidx.compose.foundation.BorderStroke(1.dp, LocalText.current.copy(alpha = 0.35f)) else null,
                ) {
                    Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                        Text(label, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                        if (o.optString("description").isNotBlank()) {
                            Text(o.optString("description"), fontSize = 11.sp, color = LocalMuted.current)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                custom, { custom = it },
                Modifier.weight(1f),
                placeholder = { Text("自行输入…", fontSize = 12.sp, color = LocalMuted.current) },
                singleLine = true,
            )
            TextButton(
                {
                    // Custom words win when typed; otherwise the picks, gathered
                    // in question order.
                    val answer = if (custom.isNotBlank()) {
                        listOf(custom.trim())
                    } else {
                        (0 until questions.length()).flatMap { picks[it].orEmpty() }
                    }
                    if (answer.isNotEmpty()) onAnswer(item.requestId, answer)
                },
            ) { Text("发送") }
        }
    }
}

@Composable
/**
 * What a permission request is asking to do, in MCode's own words.
 *
 * The card used to print the protocol's `kind` - "权限请求：bash" - which is
 * a wire identifier, not something to show a reader. These are the desktop's
 * permission verbs.
 */
fun permVerbOf(kind: String): String = when (kind) {
    "bash" -> "执行命令"
    // A delete is asked every time and says so, the way the desktop words it.
    "bashDelete" -> "执行删除命令"
    "edit" -> "修改文件"
    "write" -> "写入文件"
    "outside" -> "访问工作目录外的文件"
    "webfetch" -> "访问网络"
    // Reads are asked for too once the bucket is set that way, and "执行操作"
    // told the reader nothing about what was about to be touched.
    "read" -> "读取文件"
    "list" -> "查看目录"
    "grep", "glob" -> "搜索文件"
    "mcp" -> "调用工具"
    else -> "执行操作"
}


@Composable
fun PermCard(item: Item.Perm, onPerm: (String, String) -> Unit, onPermReason: (String, String) -> Unit = { _, _ -> }) {
    val request = item.request
    val kind = request.optString("kind", "tool")
    val forced = request.optBoolean("forced", false)
    val isBash = kind == "bash"
    val subject = request.optString("subject")
    val preview = request.optString("preview")
    val isDiff = preview.startsWith("--- a/")

    // The model's one-line account of what the command is for. For a request
    // the verb cannot name (an MCP tool, a read) it is the request's title, so
    // nothing it said is lost.
    val title = request.optString("title")
    // A request the verb cannot name shows the request's own title; a bare
    // tool name is not a title, so it is named here instead of printed raw.
    // A request the verb already names needs no chip; one it cannot name shows
    // the request's own words. A bare tool name is not a title, so it never
    // reaches the card - 「请求执行操作 glob」 told the reader nothing.
    val hasVerb = kind in setOf("bash", "edit", "write", "outside", "webfetch", "read", "list", "grep", "glob", "mcp")
    val chip = when {
        isBash && title.isNotBlank() && title != "Run command" -> title
        hasVerb -> ""
        title.isNotBlank() && title != kind -> title
        else -> ""
    }

    // A command is shown in full, capped so a runaway argument cannot flood the
    // card. One line is shown at a time; anything longer folds behind a toggle.
    val full = (if (isBash) "$ $subject" else subject).take(3000)
    val firstLine = full.substringBefore('\n')
    val lossy = full.contains('\n') || firstLine.length > 120
    var showFull by remember(item.requestId) { mutableStateOf(false) }
    var showDiff by remember(item.requestId) { mutableStateOf(false) }
    var reasoning by remember(item.requestId) { mutableStateOf(false) }
    var reason by remember(item.requestId) { mutableStateOf("") }

    Column(
        /*
         * `.err-card` / the permission dock: a 16 corner with 12 above and
         * below and 14 at the sides. This carried a 20 corner, so the card read
         * as a softer, rounder thing than every other panel on the page.
         */
        Modifier
            .fillMaxWidth()
            .background(LocalSurface.current, RoundedCornerShape(16.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        // Head: shield, "请求执行命令", the model's chip, and the queue count.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(7.dp))
            Text(
                "请求" + permVerbOf(if (forced) "bashDelete" else kind),
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
                color = LocalText.current,
            )
            if (chip.isNotBlank()) {
                Spacer(Modifier.width(7.dp))
                Text(chip, fontSize = 12.sp, color = LocalMuted.current, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
            Spacer(Modifier.weight(1f))
            if (item.queueTotal > 1) {
                Text("${item.queuePosition}/${item.queueTotal}", fontSize = 12.sp, color = LocalMuted.current)
            }
        }
        if (full.isNotBlank()) {
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.Top) {
                Text(
                    if (lossy && !showFull) firstLine.take(120) + if (firstLine.length > 120) "…" else "" else full,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                    fontFamily = FontFamily.Monospace,
                    color = LocalMuted.current,
                    modifier = Modifier.weight(1f),
                )
                if (lossy) {
                    Text(
                        if (showFull) "收起命令" else "查看完整命令",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(start = 8.dp).clickable { showFull = !showFull },
                    )
                }
            }
        }
        if (isDiff) {
            Text(
                (if (showDiff) "▾ 收起改动" else "▸ 查看改动"),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 6.dp).clickable { showDiff = !showDiff },
            )
            if (showDiff) DiffLines(preview, Modifier.padding(top = 4.dp))
        }
        if (forced) {
            Text("删除类操作不可逆，每次执行都需单独确认", fontSize = 11.5.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 6.dp))
        }
        // Actions, in the desktop's order: refuse, refuse with a reason, always,
        // then the filled "this time" on the end.
        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PermButton("拒绝", false, Modifier.weight(1f)) { onPerm(item.requestId, "reject") }
            PermButton("拒绝并说明", true, Modifier.weight(1.3f)) { reasoning = !reasoning }
            if (!forced) PermButton("总是允许", false, Modifier.weight(1f)) { onPerm(item.requestId, "always") }
            PermButton("本次允许", false, Modifier.weight(1f), primary = true) { onPerm(item.requestId, "once") }
        }
        if (reasoning) {
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .weight(1f)
                        .background(LocalPill.current, RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 9.dp),
                ) {
                    if (reason.isEmpty()) {
                        Text("说明拒绝原因(反馈给模型)", fontSize = 13.sp, color = LocalMuted.current)
                    }
                    BasicTextField(
                        reason,
                        { reason = it },
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, color = LocalText.current),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Spacer(Modifier.width(6.dp))
                PermButton("提交", false, Modifier) { onPermReason(item.requestId, reason.trim()) }
            }
        }
    }
}

/** One button in a permission card: quiet by default, filled for the primary. */
@Composable
private fun PermButton(label: String, muted: Boolean, modifier: Modifier, primary: Boolean = false, onClick: () -> Unit) {
    Box(
        modifier
            .clip(RoundedCornerShape(9.dp))
            .background(if (primary) LocalText.current else LocalPill.current)
            .clickable { onClick() }
            .padding(vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 12.5.sp,
            fontWeight = if (primary) FontWeight.Medium else FontWeight.Normal,
            color = if (primary) LocalBg.current else if (muted) LocalMuted.current else LocalText.current,
            maxLines = 1,
        )
    }
}

/**
 * A patch, coloured the way the desktop colours one: added green, removed red.
 *
 * `isPatch` says whether there is a patch here at all - a tool's output is
 * usually not one, and then every line is plain. Before this the tool row had
 * its own copy of the same loop, so the two drifted: one drew 80 lines, the
 * other 60, and only one was monospaced.
 */
@Composable
private fun DiffLines(
    diff: String,
    modifier: Modifier = Modifier,
    isPatch: Boolean = true,
    maxLines: Int = 80,
    /** The boxed plate a diff card wears; a tool row's output sits on the page. */
    boxed: Boolean = true,
) {
    val plate = if (boxed) {
        Modifier.fillMaxWidth().background(LocalPill.current.copy(alpha = 0.5f), RoundedCornerShape(8.dp)).padding(8.dp)
    } else {
        Modifier.fillMaxWidth()
    }
    Column(modifier.then(plate)) {
        for (line in diff.lineSequence().take(maxLines)) {
            val (bg, fg) = when {
                !isPatch -> Color.Transparent to LocalMuted.current.copy(alpha = 0.8f)
                line.startsWith("+") && !line.startsWith("+++") -> (if (LocalBg.current == DarkBg) Color(0x2631532F) else Color(0x1A20A923)) to diffAddInk()
                line.startsWith("-") && !line.startsWith("---") -> (if (LocalBg.current == DarkBg) Color(0x26553431) else Color(0x1AE5351C)) to diffDelInk()
                line.startsWith("@@") -> Color.Transparent to LocalMuted.current
                else -> Color.Transparent to LocalMuted.current.copy(alpha = 0.8f)
            }
            Text(
                line.ifEmpty { " " },
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                color = fg,
                modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 3.dp, vertical = if (boxed) 1.dp else 0.5.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionList(
    sessions: List<SessionRow>,
    current: String?,
    query: String,
    onSelect: (String) -> Unit,
    compact: Boolean,
    modifier: Modifier = Modifier,
    onLongPress: ((SessionRow) -> Unit)? = null,
    /** Rows whose turn finished out of sight, and rows parked on an answer. */
    unseen: List<String> = emptyList(),
    awaiting: List<String> = emptyList(),
) {
    val filtered = sessions.filter { it.title.contains(query, true) || it.id.contains(query, true) }
    if (filtered.isEmpty()) {
        Text("没有匹配的会话", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(16.dp))
        return
    }
    // `modifier` already carries the weight the parent gave this list; filling
    // the whole size on top of it is what made the last row slide under the
    // new-chat pill.
    // The pill below is a sibling in the same column, so the list only needs
    // its own breathing room at the bottom, not a reservation for the pill.
    LazyColumn(
        modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 6.dp),
    ) {
        for (s in filtered) {
            item(key = s.id) {
                Row(
                    // Row pitch measured off Claude on the fold: its two-line rows sit
                    // 172 px apart at 450 dpi, which is where these paddings land.
                    // The selected row gets the soft pill: `current` was passed in
                    // and never read, so the list had no idea where you were.
                    Modifier
                        .fillMaxWidth()
                        .combinedClickable(onClick = { onSelect(s.id) }, onLongClick = { onLongPress?.invoke(s) })
                        .then(
                            if (s.id == current) {
                                Modifier.background(LocalPill.current, RoundedCornerShape(10.dp))
                            } else {
                                Modifier
                            },
                        )
                        /*
                         * `.row.task > .row-open`: a 34 minimum with 6 above
                         * and below, and 2 between rows (`.lists`'s gap). This
                         * carried 14 of vertical padding and no gap, so a row
                         * was 48 tall against the desktop's 34 and the list
                         * read as spaced-out cards rather than as a thread.
                         */
                        .padding(horizontal = 14.dp, vertical = if (compact) 6.dp else 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    /*
                     * The desktop's `convo-cell`: a fixed 46px column that
                     * holds a 14px glyph centred in it (`Sidebar.vue`), so every
                     * title starts at the same x whatever the row's glyph is.
                     * This drew a 34dp icon with a 14dp end padding, which gave
                     * the same left edge by accident but made the glyph itself
                     * four times the desktop's size - a tablet row that read as
                     * an icon list rather than a conversation list.
                     */
                    Box(Modifier.width(23.dp), contentAlignment = Alignment.Center) {
                        /*
                         * The desktop's `convo-cell`: a conversation mark on
                         * every row (the path at Sidebar.vue:1288, 24 grid, 2
                         * line), and a <> for one that works in a project
                         * folder - Claude draws the same split the phone had.
                         */
                        if (s.running || s.directory.isNotBlank()) {
                            MiIcon(
                                "M5 5h14v14H5zM7.5 10.5 5.5 12l2 1.5M10.5 10.5l2 1.5-2 1.5",
                                modifier = Modifier.size(14.dp),
                                viewBox = 24f,
                                strokeWidth = 1.6f,
                                tint = LocalMuted.current,
                            )
                        } else {
                            MiIcon(
                                "M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5z",
                                modifier = Modifier.size(14.dp),
                                tint = LocalMuted.current,
                            )
                        }
                    }
                    Spacer(Modifier.width(3.dp))
                    Column(Modifier.weight(1f)) {
                        // Claude sets the title and its timestamp tight against
                        // each other (32 px between the two baselines at 450
                        // dpi), so the pair reads as one row rather than two.
                        Text(
                            s.title.ifEmpty { s.id }.take(if (compact) 34 else 26),
                            // 14 at weight 500 over a 20 line-height is the
                            // desktop's `row-label` exactly; this carried 15 at
                            // the default weight, which is a different voice.
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium,
                            lineHeight = 20.sp,
                            color = LocalText.current,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!compact) {
                            Text(
                                relTime(s.updated),
                                fontSize = 12.sp,
                                lineHeight = 16.sp,
                                color = LocalMuted.current,
                            )
                        }
                    }
                    /*
                     * The desktop's three marks (`Sidebar.vue`, `statusOf`):
                     * a turn still running is a spinning ring in the weak
                     * text colour, a turn that finished away from this row is
                     * a 7px blue dot, and one parked on a permission is the
                     * 待确认 pill. Nothing to report draws nothing - the row
                     * used to carry a grey dot whatever was happening, which
                     * said "idle" in the same breath as "unread".
                     *
                     * A running ring turns only while something runs; Compose
                     * has no CSS animation, so the angle is the clock's.
                     */
                    val waiting = s.id in awaiting
                    val unread = s.id in unseen
                    when {
                        waiting -> {
                            Text(
                                "待确认",
                                fontSize = 11.sp,
                                color = LocalMuted.current,
                                modifier = Modifier
                                    .padding(start = 8.dp)
                                    .background(LocalPill.current, RoundedCornerShape(9.dp))
                                    .padding(horizontal = 7.dp, vertical = 2.dp),
                            )
                        }
                        s.running -> {
                            val spin = rememberInfiniteTransition(label = "row-spin")
                            val angle by spin.animateFloat(
                                initialValue = 0f,
                                targetValue = 360f,
                                animationSpec = infiniteRepeatable(
                                    animation = tween(800, easing = LinearEasing),
                                    repeatMode = RepeatMode.Restart,
                                ),
                                label = "row-angle",
                            )
                            /*
                             * A 270-degree arc, turned by the clock: the missing
                             * quarter is what makes it read as spinning rather
                             * than as a ring that happens to be drawn.
                             */
                            Canvas(
                                Modifier
                                    .padding(start = 8.dp)
                                    .size(12.dp)
                                    .graphicsLayer { rotationZ = angle },
                            ) {
                                val stroke = 1.6.dp.toPx()
                                drawArc(
                                    color = DotGrey,
                                    startAngle = -90f,
                                    sweepAngle = 270f,
                                    useCenter = false,
                                    style = androidx.compose.ui.graphics.drawscope.Stroke(stroke),
                                    topLeft = androidx.compose.ui.geometry.Offset(stroke / 2, stroke / 2),
                                    size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
                                )
                            }
                        }
                        unread -> {
                            Box(
                                Modifier
                                    .padding(start = 8.dp)
                                    .size(7.dp)
                                    .background(DotBlue, CircleShape),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun DrawerContent(
    sessions: List<SessionRow>,
    onSelect: (String) -> Unit,
    onCreate: () -> Unit,
    onReconnect: () -> Unit,
    onNewTask: () -> Unit = {},
    onArtifacts: () -> Unit = {},
    onPlugins: () -> Unit = {},
    onProjects: () -> Unit = {},
    onSettings: () -> Unit = {},
    /** Which column page is open, so the drawer can mark the row for it. */
    currentPage: LeftMode = LeftMode.Sessions,
    onSearch: () -> Unit = {},
    onSeeAll: () -> Unit = {},
    onLongPress: ((SessionRow) -> Unit)? = null,
    /** See `SessionList`: the drawer's own three rows carry the same marks. */
    unseen: List<String> = emptyList(),
    awaiting: List<String> = emptyList(),
) {
    // Claude's drawer is a shade below the page it covers: 243,243,240 against
    // the page's 249,249,247, which is what makes it read as a sheet laid over
    // the conversation rather than as the page itself sliding across.
    Column(Modifier.fillMaxSize().background(if (LocalBg.current == DarkBg) Color(0xFF1C1C1B) else Color(0xFFF3F3F0))) {
        Column(Modifier.padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(28.dp))
            // Claude's drawer opens with its name at 32sp and a search glyph at
            // the far right of the same line, which opens the list's search.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("MCode", fontSize = 32.sp, fontWeight = FontWeight.Normal, color = LocalText.current, modifier = Modifier.weight(1f))
                Box(Modifier.size(36.dp).clickable { onSearch() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Search, contentDescription = "搜索", tint = LocalText.current, modifier = Modifier.size(22.dp))
                }
            }
            Spacer(Modifier.height(12.dp))
            /*
             * The desktop's side column has exactly two navigation rows - 新建任务
             * and 产物中心 - and this list had six.
             *
             * 项目, 技能与插件, 定时任务, 进行中的任务 and 用量 were all added here
             * because Claude's app has equivalents, which is the wrong reason:
             * the question is what MCode's own window offers. It offers a plugins
             * page the user asked to be hidden (Sidebar.vue: "MiMo's plugins row
             * sits between these two; the user asked for it hidden"), no
             * scheduled-tasks page at all (a scheduled run is a message in a
             * conversation, not a page), no 进行中的任务 page, and usage only as a
             * section inside Settings. 模型服务 is likewise Settings, not the rail.
             *
             * What is left is what the desktop actually puts in its column: the
             * artifact centre, and the conversation list below it. 连接设置 stays
             * because a remote app needs a way back to its own address, which the
             * desktop has no equivalent of.
             */
            /*
             * The desktop's two rows, in its order: 新建任务 (a speech bubble
             * with a plus, its own glyph in the rail) then 产物中心. 新建任务
             * leaves the drawer and opens a new conversation; it is the only
             * row the desktop's rail has besides the artifact centre.
             */
            // MiMo's 新建任务: a round speech bubble with its tail at the
            // lower left and a plus in the middle (Sidebar.vue, 24 grid, 2 line).
            DrawerItem(Icons.Outlined.ChatBubbleOutline, "新建任务", path = "M20.3 15.4A9 9 0 1 0 16.5 19.8L21 21zM12 9.5v5M9.5 12h5") {
                onNewTask()
            }
            Spacer(Modifier.height(12.dp))
            // 项目: the desktop's side column is the project list itself, so
            // it needs no row of its own; the phone's list is a page behind a
            // drawer, and without a row it is unreachable.
            DrawerItem(Icons.Outlined.Folder, "项目", active = currentPage == LeftMode.Projects) { onProjects() }
            // MiMo's 产物中心: the open tray with a screen resting in it (20 grid, 1.2 line).
            DrawerItem(
                Icons.AutoMirrored.Outlined.Article,
                "产物中心",
                active = currentPage == LeftMode.Artifacts,
                path = "M2.9 11.5h3.4l1 1.9h5.4l1-1.9h3.4M2.9 11.5 5 4.6h10l2.1 6.9M2.9 11.5v3.9h14.2v-3.9",
                pathViewBox = 20f,
                pathStroke = 1.2f,
            ) { onArtifacts() }
            // 插件: the desktop's page for MCP servers and skills, which the
            // phone had no way to reach at all - so a skill could not be turned
            // off, and a server that failed to start could not be seen.
            DrawerItem(Icons.Outlined.Extension, "插件", active = currentPage == LeftMode.Plugins) { onPlugins() }
            // 设置: the desktop's dialog, which the phone had no way into.
            DrawerItem(Icons.Outlined.Settings, "设置", active = currentPage == LeftMode.Settings) { onSettings() }
            Spacer(Modifier.height(20.dp))
            HorizontalDivider(color = LocalMuted.current.copy(alpha = 0.18f))
            Spacer(Modifier.height(18.dp))
            // `.section-head`: 12 at weight 500, in the body's grey. This read
            // 13 at the default weight, which is a size and a voice off.
            Text("最近使用", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = LocalMuted.current)
            Spacer(Modifier.height(8.dp))
        }
        /*
         * Claude's drawer shows the three most recent conversations and then a
         * 「查看全部 ›」 row that opens the full list, so the drawer always fits
         * on one screen however long the history is.
         */
        Column(Modifier.weight(1f)) {
            SessionList(
                sessions.take(3),
                null,
                "",
                onSelect,
                compact = true,
                modifier = Modifier.fillMaxWidth(),
                onLongPress = onLongPress,
                unseen = unseen,
                awaiting = awaiting,
            )
            if (sessions.size > 3) {
                Row(
                    Modifier.fillMaxWidth().clickable { onSeeAll() }.padding(horizontal = 18.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("查看全部", fontSize = 14.sp, color = LocalMuted.current)
                    Spacer(Modifier.width(4.dp))
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(16.dp))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(Ember, CircleShape), contentAlignment = Alignment.Center) {
                Text("W", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            }
            Spacer(Modifier.weight(1f))
            Button(
                onCreate,
                shape = RoundedCornerShape(22.dp),
                colors = ButtonDefaults.buttonColors(containerColor = LocalText.current, contentColor = LocalBg.current),
            ) { Text("+ 新建会话", fontSize = 14.sp) }
        }
    }
}

@Composable
fun DrawerItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    active: Boolean = false,
    /** The desktop's own `d` string; when set it draws instead of the Material glyph. */
    path: String? = null,
    /** The path's own grid and stroke, which the desktop writes on its svg. */
    pathViewBox: Float = 24f,
    pathStroke: Float = 2f,
    onClick: () -> Unit,
) {
    /*
     * Claude marks the page the app is on: the row wears a soft pill
     * (240,239,236 on the drawer's 243,243,240) and a step of horizontal inset,
     * so the drawer says where the reader already is rather than only where
     * they could go. Without it every row looked equally unvisited, and opening
     * 定时任务 read as if nothing had happened.
     */
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = if (active) 0.dp else 0.dp)
            /*
             * `.row`: a 38 minimum, an 8 corner, 14 in from each edge and 14
             * between the glyph and the words. This drew a 12 corner, 18 of
             * gap and 16sp of type, so the drawer's two rows read as headings
             * rather than as the same rows the list below is made of.
             */
            .then(
                if (active) {
                    Modifier
                        .background(
                            if (LocalBg.current == DarkBg) Color(0xFF2B2B2A) else Color(0xFFEEEDEC),
                            RoundedCornerShape(8.dp),
                        )
                } else {
                    Modifier
                },
            )
            .heightIn(min = 38.dp)
            .padding(horizontal = 14.dp)
            .clickable { onClick() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The desktop's `row-ico` is 18 in a 24 grid; where its own path is
        // known it is drawn, and the Material lookalike is only a fallback.
        if (path != null) {
            MiIcon(
                path,
                contentDescription = label,
                modifier = Modifier.size(18.dp),
                viewBox = pathViewBox,
                strokeWidth = pathStroke,
                tint = LocalText.current,
            )
        } else {
            Icon(icon, contentDescription = label, tint = LocalText.current, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(14.dp))
        Text(label, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
    }
}

/* ------------------------------------------------------------------ */
/* The left column's three pages                                       */
/* ------------------------------------------------------------------ */

/**
 * The draggable divider between the two panes.
 *
 * Measured off Claude on the pad: the bar is 10px across at 400dpi - 4dp - and
 * 120px tall - 48dp - in (216,216,214), vertically centred in the pane and not
 * at all attached to the top or bottom edge. The touch target is wider than the
 * bar (24dp) because a 4dp handle is not something a finger can find.
 */
@Composable
fun ColumnDivider(fraction: Float, totalWidthPx: Int, onChange: (Float) -> Unit) {
    val bar = if (LocalBg.current == DarkBg) Color(0xFF3E3E3C) else Color(0xFFD8D8D6)
    var paneWidth by remember { mutableStateOf(totalWidthPx) }
    LaunchedEffect(totalWidthPx) { paneWidth = totalWidthPx }
    /*
     * `pointerInput(Unit)` captures its lambda once, so a `fraction` read inside
     * it is the value from the first composition - every drag would compute from
     * the same starting point and the handle would jump back. The current
     * fraction and the callback are read through state holders instead, which is
     * what makes a drag continuous.
     */
    val live = rememberUpdatedState(fraction)
    val emit = rememberUpdatedState(onChange)
    Box(
        Modifier
            .width(32.dp)
            .fillMaxHeight()
            // A description so the handle is a node a driver can find, and so
            // a screen reader can say what it is. A bare Box is not in the tree
            // at all, which is also why `adb input swipe` had nothing to land on.
            .semantics { contentDescription = "调整分栏宽度" }
            /*
             * `draggable`, not a hand-rolled `pointerInput`: the handle sits
             * between two panes that both consume pointer events, and a raw
             * pointerInput never saw a single event here - three swipes across
             * the handle moved the split by zero. `draggable` installs a
             * proper gesture node that takes part in the hit test, so the
             * parent's scroll cannot claim the drag first.
             */
            .draggable(
                orientation = androidx.compose.foundation.gestures.Orientation.Horizontal,
                state = rememberDraggableState { delta ->
                    if (paneWidth > 0) emit.value((live.value + delta / paneWidth).coerceIn(0.18f, 0.46f))
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .width(4.dp)
                .height(48.dp)
                .background(bar, RoundedCornerShape(2.dp)),
        )
    }
}

/**
 * 插件, the desktop's page for what the model can reach: MCP servers and skills.
 *
 * Built as its own whole page like 产物中心, because that is how the desktop
 * does it - `PluginsView.vue` replaces the workspace rather than sitting in a
 * column. The layout is that page's: 插件 at 24sp, its subtitle, a search field
 * and a filter, then 已安装 over a list of cards. An MCP card names the server
 * and how many tools it offers (共 N 个工具), with its failure in the server's
 * own words under the name; a skill card names the skill and says whether it is
 * 内置技能 or 技能.
 *
 * A skill's switch is the one thing that writes: `config.set` on
 * `disabledSkills`, which is the field the loader reads - the desktop's own
 * toggle (`PluginsView.vue`) writes the same list.
 */
@Composable
fun PluginsScreen(
    servers: List<JSONObject>,
    skills: List<JSONObject>,
    loading: Boolean,
    failed: Boolean,
    onRefresh: () -> Unit,
    onToggleSkill: (String, Boolean) -> Unit,
    onClose: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    // 全部 / 已启用 / 已停用, the desktop's three status filters.
    var status by remember { mutableStateOf("all") }

    fun keep(name: String, enabled: Boolean): Boolean {
        if (query.isNotBlank() && !name.contains(query, ignoreCase = true)) return false
        return when (status) {
            "on" -> enabled
            "off" -> !enabled
            else -> true
        }
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        // The status bar is drawn over the page, so the header has to step under
        // it - without this the title sat on top of the clock and the arrow.
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clickable { onClose() }, contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(6.dp))
            Text("插件", fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current, modifier = Modifier.weight(1f))
            // The desktop's refresh glyph.
            Box(Modifier.size(38.dp).clickable { onRefresh() }, contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Refresh, contentDescription = "刷新列表", tint = LocalMuted.current, modifier = Modifier.size(18.dp))
            }
        }
        Text(
            "在 MCode 中使用你连接的工具与技能。",
            fontSize = 13.sp,
            color = LocalMuted.current,
            modifier = Modifier.padding(horizontal = 22.dp).padding(top = 2.dp, bottom = 12.dp),
        )
        OutlinedTextField(
            query, { query = it },
            Modifier.fillMaxWidth().padding(horizontal = 18.dp),
            placeholder = { Text("搜索插件和技能", fontSize = 13.sp, color = LocalMuted.current) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(16.dp)) },
            shape = RoundedCornerShape(12.dp),
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
            singleLine = true,
            colors = OutlinedTextFieldDefaults.colors(
                unfocusedContainerColor = LocalField.current,
                focusedContainerColor = LocalField.current,
                unfocusedBorderColor = LocalFieldLine.current,
                focusedBorderColor = LocalFieldLine.current,
            ),
        )
        Spacer(Modifier.height(8.dp))
        Row(Modifier.padding(horizontal = 18.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((value, word) in listOf("all" to "全部", "on" to "已启用", "off" to "已停用")) {
                val active = status == value
                Surface(
                    shape = RoundedCornerShape(15.dp),
                    color = if (active) MaterialTheme.colorScheme.primary else LocalPill.current,
                    modifier = Modifier.clickable { status = value },
                ) {
                    Text(
                        word,
                        fontSize = 13.sp,
                        color = if (active) LocalBg.current else LocalText.current,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                    )
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        if (failed) {
            Text("无法读取本机已安装的插件和技能", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp))
            return@Column
        }
        val shownServers = servers.filter { keep(it.optString("name"), it.optString("status") !in setOf("disabled", "off")) }
        val shownSkills = skills.filter { keep(it.optString("name"), it.optBoolean("enabled", true)) }
        if (!loading && shownServers.isEmpty() && shownSkills.isEmpty()) {
            Text(
                if (query.isNotBlank() || status != "all") "没有匹配的插件或技能" else "暂无已安装的插件",
                fontSize = 13.sp,
                color = LocalMuted.current,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
            )
            return@Column
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 18.dp, end = 18.dp, bottom = 24.dp)) {
            if (shownServers.isNotEmpty()) {
                item(key = "mcpHead") {
                    Text("已安装", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp))
                }
                items(shownServers.size) { index ->
                    val server = shownServers[index]
                    val name = server.optString("name")
                    val tools = server.optInt("tools", 0)
                    val error = server.optString("error")
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(bottom = 6.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(12.dp))
                            .padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                if (error.isNotBlank()) error else if (tools > 0) "共 $tools 个工具" else "插件",
                                fontSize = 12.sp,
                                color = if (error.isNotBlank()) MaterialTheme.colorScheme.error else LocalMuted.current,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
            if (shownSkills.isNotEmpty()) {
                item(key = "skillHead") {
                    Text(
                        if (shownServers.isEmpty()) "已安装" else "技能",
                        fontSize = 13.sp,
                        color = LocalMuted.current,
                        modifier = Modifier.padding(top = 8.dp, bottom = 6.dp),
                    )
                }
                items(shownSkills.size) { index ->
                    val skill = shownSkills[index]
                    val name = skill.optString("name")
                    val description = skill.optString("description")
                    val enabled = skill.optBoolean("enabled", true)
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(bottom = 6.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(12.dp))
                            .padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                if (description.isNotBlank()) description else if (skill.optBoolean("builtin")) "内置技能" else "技能",
                                fontSize = 12.sp,
                                color = LocalMuted.current,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Spacer(Modifier.width(10.dp))
                        /*
                         * The switch. A built-in skill can be turned off as well
                         * as a user one - `disabledSkills` is the same list - but
                         * a skill that cannot be uninstalled is still a skill the
                         * model reads, so only `enabled` is offered here.
                         */
                        Switch(
                            checked = enabled,
                            onCheckedChange = { onToggleSkill(name, it) },
                            modifier = Modifier.size(width = 44.dp, height = 26.dp),
                        )
                    }
                }
            }
        }
    }
}

/** One row of the projects page: the folder, what it is called, how much is in it. */
data class ProjectRowData(val directory: String, val name: String, val sessions: Int, val lastUsed: Long)

/**
 * 项目, the list the desktop's side column is built around.
 *
 * The desktop has no separate page for this - its column *is* the project list,
 * with each project's conversations folded under it - so this page is the
 * phone's stand-in for that grouping, and it carries what the desktop's project
 * menu does in its own words: 重命名项目, and 移除 (the desktop's own danger
 * row), which take the project off the list while its conversations stay.
 *
 * Two ways in from the desktop's home: 新建空白项目, which makes a folder and
 * adds it (`project.createBlank`), and 添加文件夹, which adds a path that
 * already exists (`project.add`). The desktop reaches for a system folder
 * picker there; a tablet has one too, but not through the gateway, so the path
 * is typed - the same trade the connect screen makes.
 *
 * The order is `projectsByRecency` in `shared/projects.ts`: the later of the
 * project's newest conversation and its last pick first, the stored list
 * breaking ties.
 */
@Composable
fun ProjectsScreen(
    rows: List<ProjectRowData>,
    onOpen: (String) -> Unit,
    onCreateBlank: (String) -> Unit,
    onAddFolder: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onRemove: (String) -> Unit,
    onClose: () -> Unit,
) {
    var menuFor by remember { mutableStateOf<String?>(null) }
    var renameFor by remember { mutableStateOf<String?>(null) }
    var renameDraft by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    var addDraft by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var createDraft by remember { mutableStateOf("") }
    val muted = LocalMuted.current
    val ink = LocalText.current
    val fieldLine = LocalFieldLine.current
    val fieldBg = LocalField.current

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        // The status bar is drawn over the page, so the header steps under it -
        // without this the title sat on top of the clock, as the plugins page's
        // first cut did.
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clickable { onClose() }, contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(6.dp))
            Text("项目", fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current, modifier = Modifier.weight(1f))
        }
        if (rows.isEmpty()) {
            // The empty outline: a folder with no fill, the words, and the one
            // sentence that says what a project is.
            Column(Modifier.fillMaxWidth().padding(top = 90.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Outlined.Folder, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(63.dp))
                Spacer(Modifier.height(14.dp))
                Text("暂无项目", fontSize = 16.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                Spacer(Modifier.height(4.dp))
                Text("添加一个文件夹，把它的对话归在一起。", fontSize = 13.sp, color = LocalMuted.current)
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 18.dp, end = 18.dp, top = 6.dp, bottom = 20.dp)) {
            items(rows.size) { index ->
                val row = rows[index]
                Box(Modifier.fillMaxWidth().padding(bottom = 6.dp)) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(12.dp))
                            .clickable { onOpen(row.directory) }
                            .padding(start = 12.dp, end = 2.dp, top = 11.dp, bottom = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.Folder, contentDescription = null, tint = Ember, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(row.name, fontSize = 14.sp, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.height(1.dp))
                            Text(
                                row.directory,
                                fontSize = 11.sp,
                                color = muted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(
                            if (row.sessions == 1) "1 个会话" else "${row.sessions} 个会话",
                            fontSize = 11.sp,
                            color = muted,
                        )
                        Spacer(Modifier.width(2.dp))
                        Box(
                            Modifier.size(34.dp).clickable { menuFor = if (menuFor == row.directory) null else row.directory },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Outlined.MoreVert, contentDescription = "项目菜单", tint = muted, modifier = Modifier.size(18.dp))
                        }
                        androidx.compose.material3.DropdownMenu(
                            expanded = menuFor == row.directory,
                            onDismissRequest = { menuFor = null },
                            modifier = Modifier.width(180.dp).background(MaterialTheme.colorScheme.surface),
                        ) {
                            MenuRow(label = "重命名项目", onClick = {
                                menuFor = null
                                renameFor = row.directory
                                renameDraft = row.name
                            })
                            HorizontalDivider(color = muted.copy(alpha = 0.12f))
                            MenuRow(label = "移除", danger = true, onClick = {
                                menuFor = null
                                onRemove(row.directory)
                            })
                        }
                    }
                }
            }
        }
        // The two ways a project comes into being, at the foot of the page the
        // way the desktop's home carries them.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = LocalPill.current,
                modifier = Modifier.weight(1f).clickable { creating = true },
            ) {
                Row(Modifier.padding(vertical = 10.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Add, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(5.dp))
                    Text("新建空白项目", fontSize = 13.sp, color = LocalText.current)
                }
            }
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = LocalPill.current,
                modifier = Modifier.weight(1f).clickable { adding = true; addDraft = "" },
            ) {
                Row(Modifier.padding(vertical = 10.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.FolderOpen, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(5.dp))
                    Text("添加文件夹", fontSize = 13.sp, color = LocalText.current)
                }
            }
        }
        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
    }

    if (renameFor != null) {
        val dir = renameFor ?: return
        AlertDialog(
            onDismissRequest = { renameFor = null },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = ink,
            textContentColor = ink,
            title = { Text("重命名项目", fontSize = 16.sp) },
            text = {
                OutlinedTextField(
                    renameDraft, { renameDraft = it },
                    Modifier.fillMaxWidth(),
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                    shape = RoundedCornerShape(10.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        unfocusedContainerColor = fieldBg,
                        focusedContainerColor = fieldBg,
                        unfocusedBorderColor = fieldLine,
                        focusedBorderColor = fieldLine,
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = renameDraft.isNotBlank(),
                    onClick = {
                        onRename(dir, renameDraft.trim())
                        renameFor = null
                    },
                ) { Text("保存") }
            },
            dismissButton = { TextButton({ renameFor = null }) { Text("取消", color = ink) } },
        )
    }
    if (adding) {
        AlertDialog(
            onDismissRequest = { adding = false },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = ink,
            textContentColor = ink,
            title = { Text("添加文件夹", fontSize = 16.sp) },
            text = {
                Column {
                    Text("输入一个已存在的文件夹的完整路径。", fontSize = 13.sp, color = muted, lineHeight = 20.sp)
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        addDraft, { addDraft = it },
                        Modifier.fillMaxWidth(),
                        singleLine = true,
                        placeholder = { Text("D:\\work\\my-project", fontSize = 13.sp, color = muted) },
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                        shape = RoundedCornerShape(10.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            unfocusedContainerColor = fieldBg,
                            focusedContainerColor = fieldBg,
                            unfocusedBorderColor = fieldLine,
                            focusedBorderColor = fieldLine,
                        ),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = addDraft.trim().length > 2,
                    onClick = {
                        onAddFolder(addDraft.trim())
                        adding = false
                    },
                ) { Text("添加") }
            },
            dismissButton = { TextButton({ adding = false }) { Text("取消", color = ink) } },
        )
    }
    if (creating) {
        AlertDialog(
            onDismissRequest = { creating = false },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = ink,
            textContentColor = ink,
            title = { Text("新建空白项目", fontSize = 16.sp) },
            text = {
                Column {
                    Text("在默认工作区下建一个空文件夹，作为新项目。", fontSize = 13.sp, color = muted, lineHeight = 20.sp)
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        createDraft, { createDraft = it },
                        Modifier.fillMaxWidth(),
                        singleLine = true,
                        placeholder = { Text("项目名称", fontSize = 13.sp, color = muted) },
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                        shape = RoundedCornerShape(10.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            unfocusedContainerColor = fieldBg,
                            focusedContainerColor = fieldBg,
                            unfocusedBorderColor = fieldLine,
                            focusedBorderColor = fieldLine,
                        ),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = createDraft.isNotBlank(),
                    onClick = {
                        onCreateBlank(createDraft.trim())
                        createDraft = ""
                        creating = false
                    },
                ) { Text("创建") }
            },
            dismissButton = { TextButton({ creating = false }) { Text("取消", color = ink) } },
        )
    }
}

/** Which page the left column is showing. Claude switches between them in place. */
enum class LeftMode { Sessions, Projects, Artifacts, Plugins, Settings }

/**
 * The black capsule at the foot of the column.
 *
 * Its words follow the page - 新建会话, 新建项目, 新建任务 - which is the whole
 * reason it is shared: three pages, one control, and what it does is named by
 * the page it sits on.
 */
@Composable
fun FootCapsule(label: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = if (enabled) LocalText.current else LocalMuted.current.copy(alpha = 0.4f),
        modifier = Modifier.padding(top = 8.dp, bottom = 10.dp).then(modifier).clickable(enabled = enabled) { onClick() },
    ) {
        Row(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, fontSize = 14.sp, color = LocalBg.current)
        }
    }
}

/**
 * Claude's projects page, in the left column.
 *
 * An outlined folder, 「暂无项目」 and the sentence under it when there is
 * nothing; otherwise every folder the app treats as a project, with the one the
 * list is filtered to marked. Picking one goes back to the list filtered to it,
 * which is what the same tap does on the desktop's side column.
 */
/** The outline Claude draws for an empty projects page: a folder, no fill, 63dp. */
/**
 * Claude's scheduled-tasks page: a clock, 「暂无定时任务」, and what the app will do
 * with one. The rows come from the `automation.tasks` event the server
 * broadcasts; there is no request that lists them, so this page listens.
 */

/**
 * 作品: what the app has made, grouped by the conversation that made it.
 *
 * `artifact.list` answers one entry per conversation with its files, newest
 * first. A file that has since been deleted or moved still has a row - the
 * entry says `exists: false` - because the point of the page is to remember
 * that this was produced, not only to hand it over again.
 */

/** The text extensions `shared/attachment-kind.ts` names; the same list the server reads when the message is built. */
private val TEXTUAL_EXTENSIONS = setOf(
    "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "asciidoc", "org", "tex", "bib",
    "html", "htm", "xhtml", "xml", "vue", "svelte", "astro", "css", "scss", "sass", "less", "styl",
    "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
    "py", "pyi", "pyw", "rb", "go", "rs", "java", "kt", "kts", "gradle", "swift", "scala", "clj", "cljs",
    "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "m", "mm", "cs", "fs", "php", "pl", "pm", "lua", "r",
    "dart", "ex", "exs", "erl", "hs", "jl", "nim", "zig", "v", "vb", "groovy", "sql", "graphql", "gql", "proto",
    "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "awk", "sed", "mk", "cmake", "makefile", "dockerfile",
    "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "editorconfig",
    "npmrc", "nvmrc", "babelrc", "eslintrc", "prettierrc", "gitignore", "gitattributes", "dockerignore",
    "csv", "tsv", "log", "diff", "patch", "lock", "tf", "tfvars", "hcl", "tfstate", "plist", "srt", "vtt",
)

/** Whether a file's name says it reads as text, by the desktop's own extension table. */
private fun textualName(file: String): Boolean {
    val name = file.substringAfterLast('/').substringAfterLast('\\')
    val dot = name.lastIndexOf('.')
    val ext = if (dot > 0) name.substring(dot + 1).lowercase() else name.removePrefix(".").lowercase()
    return ext in TEXTUAL_EXTENSIONS
}

/* ------------------------------------------------------------------ */
/* 产物中心 - the desktop's own page for what the app has produced     */
/* ------------------------------------------------------------------ */

/**
 * The artifact badge: a colour and a glyph per kind, as MiMo's tiles wear them.
 *
 * Its colours are the desktop's (`lib/artifact-kind.ts`), unchanged between the
 * two themes there, and its tints are that colour at 12%.
 */
internal data class Badge(val label: String, val fg: Color, val glyph: (DrawScope) -> Unit)

private fun badgeOf(path: String): Badge {
    /*
     * The desktop's own table (`lib/artifact-kind.ts`), not a guess of it: its
     * eight kinds, its eight colours, and its own words. A .ts or .sh is
     * 「文件」 there rather than 文档, and .md is 文本 rather than Word - the kind
     * is decided by what the tile says, so a table that disagrees makes the same
     * file wear one badge on the desktop and another here.
     */
    val ext = path.substringAfterLast('.', "").lowercase()
    // MiMo's page: a sheet with a folded corner and three ruled lines.
    fun page(color: Color, label: String) = Badge(label, color) { s ->
        val w = s.size.width; val h = s.size.height
        val st = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.062f)
        val ink = color
        // The outline: down the left, round the fold at the top right, to the foot.
        val body = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.24f, h * 0.1f)
            lineTo(w * 0.62f, h * 0.1f)
            lineTo(w * 0.78f, h * 0.28f)
            lineTo(w * 0.78f, h * 0.9f)
            lineTo(w * 0.24f, h * 0.9f)
            close()
        }
        s.drawPath(body, ink, style = st)
        s.drawLine(ink, androidx.compose.ui.geometry.Offset(w * 0.62f, h * 0.1f), androidx.compose.ui.geometry.Offset(w * 0.62f, h * 0.28f), w * 0.055f)
        s.drawLine(ink, androidx.compose.ui.geometry.Offset(w * 0.62f, h * 0.28f), androidx.compose.ui.geometry.Offset(w * 0.78f, h * 0.28f), w * 0.055f)
        for (i in 0..2) {
            val y = h * (0.46f + i * 0.15f)
            s.drawLine(ink, androidx.compose.ui.geometry.Offset(w * 0.34f, y), androidx.compose.ui.geometry.Offset(w * (if (i == 2) 0.56f else 0.68f), y), w * 0.05f)
        }
    }
    return when (ext) {
        "doc", "docx" -> page(Color(0xFF2B6CB0), "Word")
        "ppt", "pptx" -> Badge("PPT", Color(0xFFC43E1C)) { s ->
            val w = s.size.width; val h = s.size.height
            val st = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.06f)
            s.drawRoundRect(Color(0xFFC43E1C), androidx.compose.ui.geometry.Offset(w * 0.14f, h * 0.14f),
                androidx.compose.ui.geometry.Size(w * 0.72f, h * 0.46f),
                androidx.compose.ui.geometry.CornerRadius(w * 0.06f), style = st)
            val stand = androidx.compose.ui.graphics.Path().apply {
                moveTo(w * 0.24f, h * 0.88f); lineTo(w * 0.44f, h * 0.62f)
                lineTo(w * 0.56f, h * 0.62f); lineTo(w * 0.76f, h * 0.88f)
            }
            s.drawPath(stand, Color(0xFFC43E1C), style = st)
        }
        "xls", "xlsx", "csv" -> Badge("Excel", Color(0xFF21A366)) { s ->
            val w = s.size.width; val h = s.size.height
            val st = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.062f)
            val body = androidx.compose.ui.graphics.Path().apply {
                moveTo(w * 0.24f, h * 0.1f); lineTo(w * 0.62f, h * 0.1f)
                lineTo(w * 0.78f, h * 0.28f); lineTo(w * 0.78f, h * 0.9f)
                lineTo(w * 0.24f, h * 0.9f); close()
            }
            s.drawPath(body, Color(0xFF21A366), style = st)
            // Two columns of cells, which is what makes a sheet a sheet.
            for (i in 0..1) {
                val y = h * (0.5f + i * 0.16f)
                s.drawLine(Color(0xFF21A366), androidx.compose.ui.geometry.Offset(w * 0.34f, y), androidx.compose.ui.geometry.Offset(w * 0.44f, y), w * 0.05f)
                s.drawLine(Color(0xFF21A366), androidx.compose.ui.geometry.Offset(w * 0.54f, y), androidx.compose.ui.geometry.Offset(w * 0.64f, y), w * 0.05f)
            }
        }
        "pdf" -> Badge("PDF", Color(0xFFD93831)) { s ->
            val w = s.size.width; val h = s.size.height
            val st = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.062f)
            // MiMo's PDF mark is the corner-cut page with a letter standing in the notch.
            val body = androidx.compose.ui.graphics.Path().apply {
                moveTo(w * 0.5f, h * 0.92f); lineTo(w * 0.78f, h * 0.92f)
                lineTo(w * 0.78f, h * 0.28f); lineTo(w * 0.56f, h * 0.08f)
                lineTo(w * 0.24f, h * 0.08f); lineTo(w * 0.24f, h * 0.34f)
            }
            s.drawPath(body, Color(0xFFD93831), style = st)
            val t = androidx.compose.ui.graphics.Path().apply {
                moveTo(w * 0.12f, h * 0.6f); lineTo(w * 0.44f, h * 0.6f)
                moveTo(w * 0.28f, h * 0.6f); lineTo(w * 0.28f, h * 0.9f)
                moveTo(w * 0.22f, h * 0.9f); lineTo(w * 0.34f, h * 0.9f)
            }
            s.drawPath(t, Color(0xFFD93831), style = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.055f))
        }
        "md", "markdown", "txt", "rtf" -> page(Color(0xFF4B5563), "文本")
        "html", "htm" -> Badge("落地页", Color(0xFF2F6FED)) { s ->
            val w = s.size.width; val h = s.size.height
            val st = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.06f)
            s.drawCircle(Color(0xFF2F6FED), w * 0.4f, androidx.compose.ui.geometry.Offset(w / 2, h / 2), style = st)
            // MiMo's globe: the equator and the two meridians.
            s.drawLine(Color(0xFF2F6FED), androidx.compose.ui.geometry.Offset(w * 0.1f, h / 2), androidx.compose.ui.geometry.Offset(w * 0.9f, h / 2), w * 0.055f)
            val rim = androidx.compose.ui.graphics.Path().apply {
                moveTo(w * 0.31f, h * 0.14f)
                cubicTo(w * 0.52f, h * 0.2f, w * 0.52f, h * 0.8f, w * 0.31f, h * 0.86f)
                moveTo(w * 0.69f, h * 0.14f)
                cubicTo(w * 0.48f, h * 0.2f, w * 0.48f, h * 0.8f, w * 0.69f, h * 0.86f)
            }
            s.drawPath(rim, Color(0xFF2F6FED), style = st)
        }
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico" -> Badge("图片", Color(0xFF0E9488)) { s ->
            val w = s.size.width; val h = s.size.height
            val st = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.062f)
            s.drawRoundRect(Color(0xFF0E9488), androidx.compose.ui.geometry.Offset(w * 0.14f, h * 0.14f),
                androidx.compose.ui.geometry.Size(w * 0.72f, h * 0.72f),
                androidx.compose.ui.geometry.CornerRadius(w * 0.09f), style = st)
            s.drawCircle(Color(0xFF0E9488), w * 0.075f, androidx.compose.ui.geometry.Offset(w * 0.36f, h * 0.36f))
            val hill = androidx.compose.ui.graphics.Path().apply {
                moveTo(w * 0.16f, h * 0.78f); lineTo(w * 0.4f, h * 0.52f)
                lineTo(w * 0.58f, h * 0.68f); lineTo(w * 0.66f, h * 0.6f)
                lineTo(w * 0.86f, h * 0.78f)
            }
            s.drawPath(hill, Color(0xFF0E9488), style = st)
        }
        else -> page(Color(0xFF8C8C86), "文件")
    }
}

/** One artifact as the page lists it: flattened out of the groups the server sends. */
internal data class ArtRow(
    val key: String,
    val path: String,
    val name: String,
    val at: Long,
    val root: String,
    val badge: Badge,
)

/** Every file from every conversation, newest write first - the desktop's order. */
internal fun artifactRows(groups: List<JSONObject>): List<ArtRow> {
    val out = mutableListOf<ArtRow>()
    for (g in groups) {
        val sessionID = g.optString("sessionID")
        val root = g.optString("directory")
        val files = g.optJSONArray("files") ?: continue
        for (i in 0 until files.length()) {
            val f = files.optJSONObject(i) ?: continue
            // A file that is gone has nothing to preview, and the desktop's page
            // leaves it out rather than showing a row that cannot be opened.
            if (!f.optBoolean("exists", true)) continue
            val path = f.optString("path")
            if (path.isBlank()) continue
            out.add(
                ArtRow(
                    key = "$sessionID:$path",
                    path = path,
                    name = path.substringAfterLast('/').substringAfterLast('\\'),
                    at = f.optLong("at", 0L),
                    root = root,
                    badge = badgeOf(path),
                ),
            )
        }
    }
    return out.sortedByDescending { it.at }
}

/** MiMo's floored tile time: just now, minutes, hours, days under a week, then the date. */
fun artifactWhen(at: Long, now: Long): String {
    if (at <= 0L) return ""
    val seconds = ((now - at) / 1000).coerceAtLeast(0)
    if (seconds < 60) return "刚刚"
    val minutes = seconds / 60
    if (minutes < 60) return "${minutes} 分钟前"
    val hours = minutes / 60
    if (hours < 24) return "${hours} 小时前"
    val days = hours / 24
    if (days < 7) return "${days} 天前"
    return android.text.format.DateFormat.format("yyyy/M/d", at).toString()
}

/**
 * 产物中心, as the desktop builds it: a 980px column with the title, a line under
 * it, a search field, the four facet chips with the server's counts, a grid/list
 * toggle at the end of the same row, then tiles three across.
 *
 * This had been a pane inside the left column, grouped by conversation. The
 * desktop's is a page of its own and groups by nothing: every file from every
 * conversation, newest write first, because the question it answers is "what did
 * I make" rather than "what did that conversation make".
 */
@Composable
fun ArtifactsScreen(
    groups: List<JSONObject>,
    loading: Boolean,
    failed: Boolean,
    facets: JSONObject?,
    category: String,
    query: String,
    onQuery: (String) -> Unit,
    onCategory: (String) -> Unit,
    onRefresh: () -> Unit,
    onOpen: (String, String) -> Unit,
    onClose: () -> Unit,
) {
    var grid by remember { mutableStateOf(true) }
    val rows = remember(groups) { artifactRows(groups) }
    val needle = query.trim().lowercase()
    /*
     * The search matches the file's *name*, which is what the desktop's own
     * filter tests (`file.split(/[\\/]/).pop()`): typing "test" finds
     * connect.test.ts, and typing a folder that happens to be in every path
     * finds nothing in particular.
     */
    val shown = if (needle.isEmpty()) rows else rows.filter { it.name.lowercase().contains(needle) }
    val now = remember { System.currentTimeMillis() }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp).clickable { onClose() }, contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(20.dp))
            }
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 40.dp, end = 40.dp, top = 14.dp, bottom = 40.dp),
        ) {
            item {
                Text("产物中心", fontSize = 24.sp, lineHeight = 30.sp, color = LocalText.current)
                Spacer(Modifier.height(6.dp))
                Text(
                    "这里汇总了你在 MCode 里生成过的全部产物，可预览、下载或回到对话继续",
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    color = LocalMuted.current,
                )
                Spacer(Modifier.height(16.dp))
                // The search field: 36dp tall on the desktop, a hairline pill.
                OutlinedTextField(
                    query,
                    onQuery,
                    Modifier.fillMaxWidth().heightIn(min = 36.dp),
                    placeholder = { Text("搜索产物", fontSize = 13.sp, color = LocalMuted.current) },
                    leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(15.dp)) },
                    shape = RoundedCornerShape(8.dp),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
                    colors = OutlinedTextFieldDefaults.colors(
                        unfocusedContainerColor = LocalField.current,
                        focusedContainerColor = LocalField.current,
                        unfocusedBorderColor = LocalFieldLine.current,
                        focusedBorderColor = LocalFieldLine.current,
                    ),
                    singleLine = true,
                )
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((key, label, count) in listOf(
                            Triple("", "全部", facets?.optInt("total") ?: 0),
                            Triple("doc", "文档", facets?.optInt("doc") ?: 0),
                            Triple("app", "应用", facets?.optInt("app") ?: 0),
                            Triple("other", "其他", facets?.optInt("other") ?: 0),
                        )) {
                            val on = category == key
                            Surface(
                                shape = RoundedCornerShape(10.dp),
                                color = if (on) LocalPill.current else Color.Transparent,
                                modifier = Modifier.clickable { onCategory(key) },
                            ) {
                                Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(label, fontSize = 14.sp, color = if (on) LocalText.current else LocalMuted.current)
                                    if (!loading) {
                                        Spacer(Modifier.width(5.dp))
                                        Text("$count", fontSize = 12.sp, color = LocalMuted.current)
                                    }
                                }
                            }
                        }
                    }
                    // MiMo's two layouts, at the end of the filter row.
                    Box(Modifier.size(30.dp).clickable { grid = !grid }, contentAlignment = Alignment.Center) {
                        Icon(
                            if (grid) Icons.AutoMirrored.Outlined.Article else Icons.Outlined.Folder,
                            contentDescription = if (grid) "列表视图" else "网格视图",
                            tint = LocalMuted.current,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
            }
            if (failed) {
                item {
                    Row(Modifier.fillMaxWidth().padding(vertical = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("加载产物索引失败", fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.width(10.dp))
                        TextButton(onRefresh) { Text("重试", fontSize = 13.sp) }
                    }
                }
            } else if (loading && shown.isEmpty()) {
                item {
                    Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = LocalMuted.current)
                    }
                }
            } else if (shown.isEmpty()) {
                item {
                    Text("还没有任何产物，去对话里生成一些吧。", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(vertical = 32.dp))
                }
            } else if (grid) {
                // Three across with 14 between, as MiMo lays its grid.
                for (chunk in shown.chunked(3)) {
                    item {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            for (row in chunk) {
                                ArtifactTile(row, now, Modifier.weight(1f)) { onOpen(row.root, row.path) }
                            }
                            repeat(3 - chunk.size) { Spacer(Modifier.weight(1f)) }
                        }
                        Spacer(Modifier.height(14.dp))
                    }
                }
            } else {
                for (row in shown) {
                    item {
                        Row(
                            Modifier.fillMaxWidth().clickable { onOpen(row.root, row.path) }.padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            BadgeMark(row.badge, 26.dp)
                            Spacer(Modifier.width(12.dp))
                            Text(row.name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(artifactWhen(row.at, now), fontSize = 12.sp, color = LocalMuted.current)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)))
    }
}

/** MiMo's tile: a well with the mark and its kind, the name under it, the age and conversation at the foot. */
@Composable
private fun ArtifactTile(row: ArtRow, now: Long, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(14.dp))
            .clickable { onClick() },
    ) {
        Box(
            Modifier.fillMaxWidth().height(96.dp).background(LocalBg.current),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.size(38.dp)) { row.badge.glyph(this) }
            Row(
                Modifier.align(Alignment.BottomStart).padding(8.dp)
                    .background(row.badge.fg.copy(alpha = 0.12f), RoundedCornerShape(6.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(5.dp).background(row.badge.fg, CircleShape))
                Spacer(Modifier.width(4.dp))
                Text(row.badge.label, fontSize = 10.sp, color = row.badge.fg)
            }
        }
        Column(Modifier.padding(horizontal = 11.dp, vertical = 9.dp)) {
            Text(row.name, fontSize = 13.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Text(artifactWhen(row.at, now), fontSize = 11.sp, color = LocalMuted.current)
        }
    }
}

@Composable
private fun BadgeMark(badge: Badge, size: androidx.compose.ui.unit.Dp) {
    Canvas(Modifier.size(size)) { badge.glyph(this) }
}

/* ------------------------------------------------------------------ */
/* 技能与插件 - one page's rows                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 追求目标 - the bar, its switch, and the plus menu's rows            */
/* ------------------------------------------------------------------ */

/**
 * MiMo's goal bar above the composer.
 *
 * One line: a target mark, the state in bold ("进行中" / "已暂停" / "已完成" /
 * "受阻"), how long it has been running, then the goal itself. What the right
 * end offers depends on whether the goal is still being pursued - a live goal
 * can be dropped or its turn stopped, an answered one can be rewritten, run
 * again, or put away. The bar is one line tall until the reader asks for more,
 * because a long goal would otherwise take the whole composer.
 */
@Composable
fun GoalBar(
    goal: GoalInfo,
    running: Boolean,
    modifier: Modifier = Modifier,
    onRemove: () -> Unit = {},
    onResend: () -> Unit = {},
    onEdit: () -> Unit = {},
) {
    // The four words the desktop's bar says, in its order of precedence.
    val status = goal.doneStatus ?: if (running) "active" else "paused"
    val live = goal.doneStatus == null
    val label = when (status) {
        "active" -> "进行中"
        "paused" -> "已暂停"
        "complete" -> "已完成"
        else -> "受阻"
    }
    val accent = when (status) {
        "active" -> MaterialTheme.colorScheme.primary
        "complete" -> Color(0xFF2E7D32)
        "blocked" -> MaterialTheme.colorScheme.error
        else -> LocalMuted.current
    }
    var expanded by remember(goal.condition) { mutableStateOf(false) }
    /*
     * The clock, MiMo's: counting while the goal is being pursued and frozen at
     * what it took once it is answered. Only the second reading matters
     * afterwards, so the ticker stops as soon as the goal ends.
     */
    var now by remember(goal.condition) { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(status) {
        while (status == "active") {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val end = if (goal.doneAt > 0L) goal.doneAt else now
    val seconds = ((end - goal.startedAt).coerceAtLeast(0L) / 1000).toInt()
    val elapsed = if (goal.startedAt <= 0L) "" else if (seconds < 60) "${seconds}s" else "${seconds / 60}m ${seconds % 60}s"

    Column(
        modifier
            .fillMaxWidth()
            .background(LocalPill.current, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TargetMark(accent, Modifier.size(14.dp))
            Spacer(Modifier.width(8.dp))
            Row(Modifier.weight(1f).clickable { expanded = !expanded }, verticalAlignment = Alignment.CenterVertically) {
                Text(
                    buildString {
                        append(label)
                        if (elapsed.isNotEmpty()) append(" · ").append(elapsed)
                        if (goal.attempts > 1) append(" · 第 ").append(goal.attempts).append(" 次")
                        append("  ")
                        append(goal.condition)
                    },
                    fontSize = 12.sp,
                    color = LocalText.current,
                    maxLines = if (expanded) 8 else 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
            if (!live) {
                GoalAction(Icons.Outlined.Edit, "编辑目标", onEdit)
                GoalAction(Icons.Outlined.PlayArrow, "重新执行", onResend)
                GoalAction(Icons.Filled.Close, "关闭", onRemove)
            } else {
                GoalAction(Icons.Outlined.DeleteOutline, "退出目标模式", onRemove)
            }
        }
        // What the judge said, once there is something to quote: the desktop
        // shows it as the bar's tooltip, and a phone has no hover.
        if (!live && goal.doneReason.isNotBlank() && expanded) {
            Spacer(Modifier.height(4.dp))
            Text(goal.doneReason, fontSize = 11.sp, color = LocalMuted.current)
        }
    }
}

/** A target: three rings, the way MiMo draws one. */
@Composable
private fun TargetMark(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val r = size.minDimension / 2
        val stroke = size.minDimension * 0.14f
        drawCircle(color, radius = r - stroke / 2, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
        drawCircle(color, radius = r * 0.52f, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
        drawCircle(color, radius = r * 0.16f)
    }
}

@Composable
private fun GoalAction(icon: androidx.compose.ui.graphics.vector.ImageVector, what: String, onClick: () -> Unit) {
    Box(Modifier.size(28.dp).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = what, tint = LocalMuted.current, modifier = Modifier.size(15.dp))
    }
}

/** The plus menu's 追求目标 switch: a track and a knob, as the desktop draws it. */
@Composable
fun GoalSwitch(on: Boolean) {
    val track = if (on) MaterialTheme.colorScheme.primary else LocalMuted.current.copy(alpha = 0.3f)
    Box(Modifier.width(38.dp).height(22.dp).background(track, RoundedCornerShape(11.dp)), contentAlignment = Alignment.CenterStart) {
        Box(
            Modifier
                .padding(horizontal = 2.dp)
                .offset { androidx.compose.ui.unit.IntOffset(if (on) 16.dp.roundToPx() else 0, 0) }
                .size(18.dp)
                .background(if (on || LocalBg.current == DarkBg) Color.White else Color.White, CircleShape),
        )
    }
}

/** One row of the plus menu: a glyph, what it does, and how it ends. */
@Composable
private fun PlusRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean,
    /** Drawn from the desktop's own path where it has one (the skill mark). */
    path: String? = null,
    pathViewBox: Float = 16f,
    pathStroke: Float = 1.2f,
    /** The chevron a row that opens a submenu carries at its end. */
    chevron: Boolean = false,
    onClick: () -> Unit,
) {
    /*
     * `Composer.vue`'s `.item`: 28 tall, 0/12 of inset, an 11 corner, 13sp at
     * 440, an 8 gap and a 14 mark. This drew 17/10/14 with 9 of padding and no
     * corner, so the plus menu read as a list of loose rows rather than as the
     * set of tight tiles the desktop shows.
     */
    val ink = if (enabled) LocalText.current else LocalMuted.current.copy(alpha = 0.5f)
    Row(
        Modifier
            .fillMaxWidth()
            // The corner needs the inset inside it, or a 0/12 row's hover would
            // paint a square into a rounded menu.
            .padding(horizontal = 6.dp)
            .height(28.dp)
            .clip(RoundedCornerShape(11.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (path != null) {
            MiIcon(path, modifier = Modifier.size(14.dp), viewBox = pathViewBox, strokeWidth = pathStroke, tint = ink)
        } else {
            Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(14.dp))
        }
        Text(label, fontSize = 13.sp, fontWeight = FontWeight(440), color = ink, modifier = Modifier.weight(1f))
        if (chevron) {
            /*
             * `.item-chev`: the 14 chevron at 50% that says a row opens
             * something rather than acting. 技能 had none, so a row that opens a
             * picker looked exactly like the two above it that fire at once.
             */
            MiIcon(
                "M6.5 4.5 10 8l-3.5 3.5",
                modifier = Modifier.size(14.dp).graphicsLayer { alpha = 0.5f },
                viewBox = 16f,
                strokeWidth = 1.2f,
                tint = ink,
            )
        }
    }
}

/**
 * The plus menu's 技能 submenu: MiMo opens a search box over the project's
 * skills, and picking one writes `/<name>` into the box - which is exactly
 * what the desktop's addSkill does, since a skill is named in the message.
 */
@Composable
private fun SkillPicker(skills: List<String>, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    val shown = remember(query, skills) {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) skills else skills.filter { it.lowercase().contains(needle) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        // The dialog's own surface, not Material's: in dark that is a brown
        // tint nobody chose, and it showed as a warm box on a near-black page.
        containerColor = MaterialTheme.colorScheme.surface,
        titleContentColor = LocalText.current,
        textContentColor = LocalText.current,
        title = { Text("技能", fontSize = 16.sp) },
        text = {
            Column(Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    query,
                    { query = it },
                    Modifier.fillMaxWidth(),
                    placeholder = { Text("搜索技能", fontSize = 13.sp, color = LocalMuted.current) },
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                    shape = RoundedCornerShape(10.dp),
                )
                Spacer(Modifier.height(6.dp))
                if (shown.isEmpty()) {
                    Text("没有匹配的技能", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(vertical = 10.dp))
                } else {
                    /*
                     * A fixed height rather than `heightIn`: an AlertDialog's text
                     * slot is measured with loose constraints, so a LazyColumn in
                     * it takes its content height and the last rows drew outside
                     * the dialog's surface (it showed as text hanging under the
                     * rounded corner). A bounded list scrolls instead.
                     */
                    LazyColumn(
                        Modifier
                            .fillMaxWidth()
                            .height(300.dp),
                    ) {
                        items(shown.size) { i ->
                            val name = shown[i]
                            Row(
                                Modifier.fillMaxWidth().clickable { onPick(name) }.padding(vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("/$name", fontSize = 14.sp, color = LocalText.current)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("取消") } },
    )
}

/* ------------------------------------------------------------------ */
/* Connect                                                             */
/* ------------------------------------------------------------------ */

@Composable
fun ConnectScreen(url: String, token: String, onConnect: (String, String) -> Unit) {
    var u by remember { mutableStateOf(url) }
    var t by remember { mutableStateOf(token) }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        MCodeMark(Modifier.size(76.dp))
        Spacer(Modifier.height(20.dp))
        Text("来思考什么？", fontSize = 21.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
        Spacer(Modifier.height(8.dp))
        Text("连接本机的 MCode 后在手机上查看、批准与发号施令", fontSize = 13.sp, color = LocalMuted.current, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            u, { u = it },
            Modifier.fillMaxWidth(),
            placeholder = { Text("ws://192.168.x.x:7900", color = LocalMuted.current) },
            shape = RoundedCornerShape(16.dp),
            colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = LocalPill.current, focusedContainerColor = LocalPill.current, unfocusedBorderColor = Color.Transparent, focusedBorderColor = Color.Transparent),
            singleLine = true,
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            t, { t = it },
            Modifier.fillMaxWidth(),
            placeholder = { Text("配对令牌（storage/remote-token.json）", color = LocalMuted.current) },
            shape = RoundedCornerShape(16.dp),
            colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = LocalPill.current, focusedContainerColor = LocalPill.current, unfocusedBorderColor = Color.Transparent, focusedBorderColor = Color.Transparent),
            singleLine = true,
        )
        Spacer(Modifier.height(14.dp))
        Button(
            { if (u.isNotBlank() && t.isNotBlank()) onConnect(u.trim(), t.trim()) },
            Modifier.fillMaxWidth().height(50.dp),
            shape = RoundedCornerShape(25.dp),
            colors = ButtonDefaults.buttonColors(containerColor = LocalText.current, contentColor = LocalBg.current),
        ) { Text("连接", fontSize = 15.sp, fontWeight = FontWeight.Medium) }
        Spacer(Modifier.height(12.dp))
        Text("地址与令牌只保存在本机", fontSize = 12.sp, color = LocalMuted.current)
    }
}

/* ------------------------------------------------------------------ */
/* Input capsule                                                       */
/* ------------------------------------------------------------------ */

/*
 * The desktop's access pill: a hand, a pencil or a shield, the level's own
 * words, and a caret.
 *
 * The three glyphs are the paths `Composer.vue` draws (`ACCESS_ICONS`), in
 * their own 16 or 18 unit boxes, rather than a Material stand-in: the hand is
 * what the desktop shows for 「默认权限」 and no Material icon is that hand.
 * A level of `full` wears the ember, as the desktop's `.pill.access.full` does,
 * because a session that never stops to ask should not look ordinary.
 */
/**
 * A token count as the desktop writes one: 1.2k, 34k, 1.1M.
 *
 * `compactTokens` in `lib/format.ts`, the same rounding - the ring's card and
 * the usage pages should not disagree about what a number looks like.
 */
fun compactTokens(n: Int): String = when {
    n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0).replace(".0M", "M")
    n >= 1_000 -> String.format("%.1fk", n / 1_000.0).replace(".0k", "k")
    else -> "$n"
}

/**
 * How full the model's context is, drawn as a ring - the composer's usage mark.
 *
 * MiMo 26.920's ring, measured off the desktop (`ContextRing.vue`): drawn in a
 * 16 unit square shown at 18dp, a circle of radius 6 under a 2.4 stroke, so
 * 6.75 and 2.7 on screen, turned so the arc starts at the top. The track is the
 * weak border and the arc the muted text.
 */
@Composable
fun ContextRing(used: Int, limit: Int, size: androidx.compose.ui.unit.Dp = 18.dp) {
    val percent = if (limit <= 0 || used <= 0) 0 else {
        val share = (used.toFloat() / limit) * 100f
        // A whole percent, at least one, and no arc past the window - the
        // desktop's own clamp.
        if (used > limit) 0 else maxOf(1, Math.round(share))
    }
    val track = if (LocalBg.current == DarkBg) Color(0xFF2E2E2E) else Color(0xFFE4E1D8)
    val arc = LocalMuted.current
    Canvas(Modifier.size(size)) {
        val k = this.size.width / 16f
        val stroke = 2.4f * k
        val inset = stroke / 2f
        drawCircle(track, radius = 6f * k, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke), center = androidx.compose.ui.geometry.Offset(8f * k, 8f * k))
        if (percent > 0) {
            drawArc(
                color = arc,
                startAngle = -90f,
                sweepAngle = 360f * (percent / 100f),
                useCenter = false,
                topLeft = androidx.compose.ui.geometry.Offset((8f - 6f) * k + inset / 2, (8f - 6f) * k + inset / 2),
                size = androidx.compose.ui.geometry.Size((12f * k) - inset, (12f * k) - inset),
                style = androidx.compose.ui.graphics.drawscope.Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round),
            )
        }
    }
}

@Composable
fun AccessGlyphs(level: String, tint: Color, size: androidx.compose.ui.unit.Dp = 15.dp) {
    val box = if ((level == "auto" || level == "full")) 18f else 16f
    Canvas(Modifier.size(size)) {
        val k = this.size.width / box
        val stroke = androidx.compose.ui.graphics.drawscope.Stroke(if (level == "ask") 1f * k else if (level == "auto") 1.13f * k else 1.03f * k)
        val p = androidx.compose.ui.graphics.Path()
        fun m(x: Float, y: Float) = p.moveTo(x * k, y * k)
        fun l(x: Float, y: Float) = p.lineTo(x * k, y * k)
        fun c(x1: Float, y1: Float, x2: Float, y2: Float, x3: Float, y3: Float) = p.cubicTo(x1 * k, y1 * k, x2 * k, y2 * k, x3 * k, y3 * k)
        when (level) {
            // The hand: three fingers, then the palm and the thumb.
            "ask" -> {
                m(6.16f, 9.25f); l(6.16f, 4.45f)
                c(6.16f, 4.03f, 6.5f, 3.69f, 6.92f, 3.69f); c(7.34f, 3.69f, 7.68f, 4.03f, 7.68f, 4.45f)
                l(7.68f, 8.26f)
                m(7.68f, 4.45f); l(7.68f, 3.44f)
                c(7.68f, 3.02f, 8.02f, 2.68f, 8.44f, 2.68f); c(8.86f, 2.68f, 9.2f, 3.02f, 9.2f, 3.44f)
                l(9.2f, 8.26f)
                m(9.2f, 4.2f)
                c(9.2f, 3.78f, 9.55f, 3.44f, 9.97f, 3.44f); c(10.38f, 3.44f, 10.73f, 3.78f, 10.73f, 4.2f)
                l(10.73f, 8.26f)
                m(10.73f, 5.72f)
                c(10.73f, 5.3f, 11.07f, 4.96f, 11.49f, 4.96f); c(11.9f, 4.96f, 12.25f, 5.3f, 12.25f, 5.72f)
                l(12.25f, 10.03f)
                c(12.25f, 11.86f, 10.77f, 13.34f, 8.95f, 13.34f)
                c(7.81f, 13.34f, 6.99f, 13.02f, 6.33f, 12.45f)
                c(5.69f, 11.89f, 5.2f, 11.05f, 4.76f, 10.03f)
                c(4.32f, 9.04f, 4.08f, 8.41f, 3.92f, 8.02f)
                c(3.85f, 7.8f, 3.96f, 7.42f, 4.3f, 7.41f)
                c(5.07f, 7.37f, 5.87f, 7.95f, 6.16f, 9.1f)
            }
            // The pencil under a stroke: 帮我审批.
            "auto" -> {
                m(9f, 14.67f); l(15f, 14.67f)
                m(12f, 3.67f)
                c(12.2f, 3.4f, 12.6f, 3.35f, 12.87f, 3.55f); c(13.3f, 3.87f, 13.5f, 4.4f, 13.4f, 4.85f)
                l(5.67f, 14f); l(3f, 14.67f); l(3.67f, 12f)
                l(12f, 3.67f)
                p.close()
            }
            // The shield with its exclamation: 完全访问.
            else -> {
                m(9f, 2.94f); l(14.45f, 5.97f); l(14.45f, 9.6f)
                c(14.45f, 12.63f, 12.15f, 14.75f, 9f, 15.05f)
                c(5.85f, 14.75f, 3.55f, 12.63f, 3.55f, 9.6f)
                l(3.55f, 5.97f); p.close()
                m(9f, 6.58f); l(9f, 9f)
                m(9f, 11.42f); l(9.01f, 11.42f)
            }
        }
        drawPath(p, tint, style = stroke)
    }
}

/**
 * The access pill, as the desktop draws it under a conversation.
 *
 * The level was reachable here only through the settings sheet, which meant a
 * reader who was being asked too often had to leave the words they were
 * writing to change it. On the desktop it is the pill beside the plus.
 */
@Composable
fun AccessPill(level: String, onPick: (String) -> Unit, fullAllowed: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    /*
     * Skipping every question is asked about once, as the desktop does
     * (`chooseAccess`: `next === "full"` sets `confirmingFull`). A level that
     * never stops to ask is the one thing here that cannot be undone by
     * another tap in the same breath, so the tap alone should not do it.
     */
    var confirmingFull by remember { mutableStateOf(false) }
    val word = when (level) {
        "auto" -> "帮我审批"
        "full" -> "完全访问"
        else -> "默认权限"
    }
    val tint = if (level == "full") MaterialTheme.colorScheme.primary else LocalText.current
    val caret = LocalMuted.current
    Box {
        Row(
            Modifier
                .clip(RoundedCornerShape(17.dp))
                .background(LocalPill.current)
                .clickable { open = true }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AccessGlyphs(level, tint)
            Spacer(Modifier.width(6.dp))
            Text(word, fontSize = 13.sp, color = tint)
            /*
             * The desktop's caret is a 16 unit chevron at the weaker text
             * colour, not a Material arrow: a filled triangle would read as a
             * spinner's neighbour rather than as "this opens".
             */
            Spacer(Modifier.width(2.dp))
            Canvas(Modifier.size(14.dp)) {
                val w = size.width
                val p = androidx.compose.ui.graphics.Path().apply {
                    moveTo(w * 0.31f, w * 0.41f)
                    lineTo(w * 0.5f, w * 0.59f)
                    lineTo(w * 0.69f, w * 0.41f)
                }
                drawPath(p, caret, style = androidx.compose.ui.graphics.drawscope.Stroke(w * 0.0625f))
            }
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.width(280.dp).background(MaterialTheme.colorScheme.surface),
        ) {
            for ((value, name, hint) in listOf(
                Triple("ask", "默认权限", "读取工作区内的文件、抓取网页无需询问；新建、修改文件或运行命令前会先请你确认"),
                Triple("auto", "帮我审批", "项目内的文件改动和常规命令无需确认；删除命令与高风险操作仍会请你确认"),
                Triple("full", "完全访问", "不经批准即可修改工作区外的文件、运行联网命令，存在安全风险，请谨慎开启"),
            )) {
                if (value == "full" && !fullAllowed) continue
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            open = false
                            if (value == "full") confirmingFull = true else onPick(value)
                        }
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    AccessGlyphs(value, if (value == level) MaterialTheme.colorScheme.primary else LocalText.current, 17.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            name,
                            fontSize = 14.sp,
                            color = if (value == level) MaterialTheme.colorScheme.primary else LocalText.current,
                        )
                        Text(hint, fontSize = 11.sp, lineHeight = 15.sp, color = LocalMuted.current)
                    }
                    // MiMo's check at the far end of the chosen row.
                    if (value == level) {
                        Spacer(Modifier.width(8.dp))
                        Icon(
                            Icons.Outlined.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
    /*
     * MiMo's own confirm, as `FullAccessDialog.vue` draws it: a 16sp title with
     * a close, the description at 14sp on a 1.65 line, then a plain 取消 and a
     * light red confirm led by a warning triangle. Nothing is focused when it
     * opens, so Enter cannot turn full access on by accident.
     */
    if (confirmingFull) {
        AlertDialog(
            onDismissRequest = { confirmingFull = false },
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = LocalText.current,
            textContentColor =
                if (LocalBg.current == DarkBg) Color(0xFFC8BdBA) else Color(0xFF3F3D39),
            title = { Text("确定要切换到完全访问模式吗？", fontSize = 16.sp, fontWeight = FontWeight.Normal) },
            text = {
                Text(
                    "完全访问允许 MCode 在未经你批准的情况下访问互联网并编辑你计算机上的任何文件。这会带来数据丢失和提示注入等风险。删除文件的命令也不会再单独询问。",
                    fontSize = 14.sp,
                    lineHeight = 23.sp,
                )
            },
            confirmButton = {
                TextButton({
                    confirmingFull = false
                    onPick("full")
                }) {
                    Icon(
                        Icons.Filled.Warning,
                        contentDescription = null,
                        tint = if (LocalBg.current == DarkBg) Color(0xFFFF9B7F) else Color(0xFFD93025),
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "开启完全访问",
                        color = if (LocalBg.current == DarkBg) Color(0xFFFF9B7F) else Color(0xFFD93025),
                    )
                }
            },
            dismissButton = { TextButton({ confirmingFull = false }) { Text("取消", color = LocalText.current) } },
        )
    }
}

@Composable
fun InputCapsule(
    enabled: Boolean,
    modelLabel: String,
    /** What the last turn spent, and the model's window - the desktop's ring. */
    contextUsed: Int = 0,
    contextLimit: Int = 0,
    onSend: (String, List<JSONObject>) -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    onMic: () -> Unit = {},
    onModel: () -> Unit = {},
    running: Boolean = false,
    inject: String? = null,
    onInjected: () -> Unit = {},
    pickImages: () -> Unit = {},
    attachments: List<JSONObject> = emptyList(),
    onRemoveAttachment: (Int) -> Unit = {},
    listening: Boolean = false,
    transcribing: Boolean = false,
    commands: List<Pair<String, String>> = emptyList(),
    queued: List<Pair<String, String>> = emptyList(),
    onQueueRemove: (String) -> Unit = {},
    onQueueSend: (String) -> Unit = {},
    /* The plus menu's other rows, as the desktop's has them. */
    onFiles: () -> Unit = {},
    onTerminal: () -> Unit = {},
    goalMode: Boolean = false,
    onToggleGoalMode: () -> Unit = {},
    /** The folder's skills, by name, for the plus menu's 技能 submenu. */
    skills: List<String> = emptyList(),
    /** 追求目标: the goal being pursued, drawn above the card as MiMo's bar is. */
    goal: GoalInfo? = null,
    onGoalRemove: () -> Unit = {},
    onGoalResend: () -> Unit = {},
    onGoalEdit: () -> Unit = {},
    /** The desktop's access pill, ask / auto / full, and whether full may be offered. */
    access0: String = "ask",
    onAccess: (String) -> Unit = {},
    fullAllowed: Boolean = true,
    /** The open folder, for the @ menu's file search. */
    directory: String = "",
    /** The folder's first entries, as (name, isDir) - the @ menu before a letter is typed. */
    atListDir: suspend (String) -> List<Pair<String, Boolean>> = { emptyList() },
    /** `file.search` as (name, relative path) - the desktop's own lookup for a mention. */
    atSearch: suspend (String, String) -> List<Pair<String, String>> = { _, _ -> emptyList() },
    /** Which conversation this box belongs to, so its draft can be put back. */
    draftKey: String = "",
    draft: String = "",
    onDraftChange: (String) -> Unit = {},
) {
    /*
     * The draft is the caller's: one per conversation, kept across a switch and
     * a restart, which is what the desktop's `composer-drafts.ts` does. Held in
     * the app rather than here because this composable is remounted whenever
     * the session changes - which is exactly when a local `remember` loses the
     * words.
     */
    var text by remember(draftKey) { mutableStateOf(draft) }
    LaunchedEffect(draftKey) { text = draft }
    LaunchedEffect(text) { onDraftChange(text) }
    LaunchedEffect(inject) { if (!inject.isNullOrEmpty()) { text = inject; onInjected() } }
    /*
     * Claude's composer card is inset from its pane on both sides - 59dp on the
     * pad, about a quarter of the pane - with 20dp corners and no drop shadow;
     * it sits on the page as a white plate, not as a floating sheet. This used
     * to run the full width of the pane at 28dp with an 8dp shadow.
     */
    /*
     * The slash menu floats above the card rather than growing inside it: the
     * desktop's opens upward over the conversation, and pushing the field down
     * to make room moved the thing being typed away from the finger.
     */
    val slashText = text.trimStart()
    val slashMenu = if (slashText.startsWith("/") && commands.isNotEmpty() && !slashText.contains(' ')) {
        val query = slashText.drop(1)
        commands.filter { it.first.contains(query, ignoreCase = true) }.take(6)
    } else {
        emptyList()
    }
    /*
     * The desktop's @ menu: the folder's entries as you type after an @, then
     * `file.search` once there is something to search for.
     *
     * Without it a file could only be named on the phone by typing out its whole
     * relative path - and a path typed from memory is a path that is wrong. The
     * desktop has opened this menu over its box since before the phone existed
     * (`Composer.vue`, `loadAt` / `searchAt`).
     */
    val root = directory
    val atSpan = run {
        val head = text.substringBeforeLast('@', "")
        if (!text.contains('@')) return@run null
        val after = text.substringAfterLast('@')
        // A mention ends at a space; another @ inside it is a mention of its own.
        if (after.contains(' ')) null else after
    }
    var atEntries by remember { mutableStateOf<List<Pair<String, Boolean>>>(emptyList()) }
    var atHits by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    LaunchedEffect(atSpan, root) {
        val query = atSpan ?: return@LaunchedEffect
        if (root.isBlank()) return@LaunchedEffect
        if (query.isBlank()) {
            atEntries = atListDir(root).take(6)
        } else {
            // The desktop waits out a pause before searching; a keystroke that
            // has already been superseded should not spend a round trip.
            kotlinx.coroutines.delay(180)
            atHits = atSearch(root, query).take(6)
        }
    }
    /*
     * Claude's composer is a little off centre: on the pad its card runs
     * x=1034..3333 in a pane from 925 to 3408 - 44dp of air on the left and
     * 30dp on the right, a card 920dp wide. Measured on the card's clean top
     * edge (y=1950); a row through its text gives white runs broken by the
     * glyphs and reads far narrower if you take the longest one.
     *
     * This used to be 118/113, symmetric, which is 1.5dp from the truth on the
     * right and 74dp from it on the left.
     */
    Box(modifier.fillMaxWidth().padding(start = 44.dp, end = 30.dp, top = 8.dp, bottom = 8.dp)) {
        /*
         * The @ menu, over the box exactly where the slash menu sits: a file
         * named and chosen here goes into the words as its relative path, which
         * is what the desktop's mention does.
         */
        val atRows: List<Pair<String, String>> = if (atSpan != null) {
            if (atSpan.isBlank()) atEntries.map { (name, dir) -> name to (if (dir) "$name/" else name) }
            else atHits.map { (name, rel) -> name to rel }
        } else emptyList()
        if (atRows.isNotEmpty()) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = LocalPill.current,
                shadowElevation = 6.dp,
                // The offset is in dp, and the rows are capped at six: a pixel
                // count per row put an eight-row menu above the top of the
                // window, where half of it could not be reached.
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .fillMaxWidth()
                    .offset(y = -((atRows.size.coerceAtMost(6) * 40) + 10).dp),
            ) {
                Column(Modifier.padding(vertical = 4.dp)) {
                    for ((name, insert) in atRows) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    /*
                                     * The half-typed mention is replaced by the
                                     * chosen path, not appended to it: keeping
                                     * "@lic" and adding "LICENSE" would leave a
                                     * path that names nothing.
                                     */
                                    val before = text.substringBeforeLast('@')
                                    text = before + "@" + insert + (if (insert.endsWith("/")) "" else " ")
                                }
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (insert.endsWith("/")) Icons.Outlined.Folder else Icons.AutoMirrored.Outlined.Article,
                                contentDescription = null,
                                tint = LocalMuted.current,
                                modifier = Modifier.size(15.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(name, fontSize = 13.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
        if (slashMenu.isNotEmpty()) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = LocalPill.current,
                shadowElevation = 6.dp,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .fillMaxWidth()
                    .offset(y = -((slashMenu.size * 40) + 10).dp),
            ) {
                Column(Modifier.padding(vertical = 4.dp)) {
                    for ((name, desc) in slashMenu) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { text = "/$name " }
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("/$name", fontSize = 13.sp, color = LocalText.current)
                            if (desc.isNotBlank()) {
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    desc,
                                    fontSize = 12.sp,
                                    color = LocalMuted.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }
            }
        }
        /*
         * The bar and the card in one column inside the floating Box: the slash
         * menu is the Box's other child and must stay absolutely placed above
         * the whole block rather than pushing it down.
         */
        Column(Modifier.fillMaxWidth()) {
        /*
         * 追求目标: MiMo's bar, above the card and inside the same inset, so the
         * goal and the words that set it read as one block. The desktop has had
         * this all along; the phone could set no goal at all, so a conversation
         * being pushed toward a condition looked exactly like one that was not.
         */
        if (goal != null) {
            GoalBar(
                goal = goal,
                running = running,
                modifier = Modifier.padding(bottom = 6.dp),
                onRemove = onGoalRemove,
                onResend = onGoalResend,
                onEdit = onGoalEdit,
            )
        }
        Surface(
            /*
             * `.box`'s own 10px corner (`Composer.vue`), not the 20 this carried:
             * at 20 the card reads as a pill sunk into the page rather than as
             * the sheet the desktop lifts off it.
             */
            shape = RoundedCornerShape(10.dp),
            color = MaterialTheme.colorScheme.surface,
            // Claude's card carries a hairline: 220,220,220 on the pad, two
            // pixels wide at 400dpi, which is what separates a white plate from
            // a page that is almost as white.
            border = androidx.compose.foundation.BorderStroke(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFDCDCDC)),
            /*
             * `.box` carries `--shadow-md`: a 1px drop in light, and in dark
             * three lifts at once - 2/4, 1/2 and a half-pixel white inner edge
             * that is what actually separates the card from a page a shade
             * lighter than it. Elevation alone gives the drop; the white inner
             * line has to be drawn.
             */
            shadowElevation = if (LocalBg.current == DarkBg) 4.dp else 2.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(horizontal = 0.dp, vertical = 0.dp)) {
                /*
                 * Queued prompts, oldest first, above the field: a line each with
                 * the words, a send-now arrow and an × to withdraw. The desktop
                 * shows them the same way, and without them a message typed
                 * during a turn looked swallowed.
                 */
                if (queued.isNotEmpty()) {
                    Column(Modifier.padding(bottom = 6.dp)) {
                        for ((id, words) in queued) {
                            Row(
                                Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    words,
                                    fontSize = 13.sp,
                                    color = LocalMuted.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Box(
                                    Modifier.size(28.dp).clickable { onQueueSend(id) },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Filled.ArrowUpward, contentDescription = "立即发送", tint = LocalMuted.current, modifier = Modifier.size(15.dp))
                                }
                                Box(
                                    Modifier.size(28.dp).clickable { onQueueRemove(id) },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Filled.Close, contentDescription = "撤回", tint = LocalMuted.current, modifier = Modifier.size(15.dp))
                                }
                            }
                        }
                    }
                }
                if (attachments.isNotEmpty()) {
                    // Claude shows pending shots as a thumbnail strip above
                    // the text field, each with an X to remove. A picture is a
                    // thumbnail; a text file has no pixels to decode - its data
                    // is the text itself - so it is a named chip instead, which
                    // is also how the desktop draws one.
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        attachments.forEachIndexed { index, att ->
                            val name = att.optString("path", "附件")
                            val mime = att.optString("mime", "")
                            if (mime.startsWith("image/")) {
                                Box {
                                    val bytes = android.util.Base64.decode(att.optString("data"), android.util.Base64.DEFAULT)
                                    val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                                    Image(
                                        bitmap = bmp.asImageBitmap(),
                                        contentDescription = name,
                                        Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)),
                                        contentScale = ContentScale.Crop,
                                    )
                                    Box(
                                        Modifier.size(18.dp).align(Alignment.TopEnd).background(Color.Black.copy(alpha = 0.6f), CircleShape).clickable { onRemoveAttachment(index) },
                                        contentAlignment = Alignment.Center,
                                    ) { Text("×", fontSize = 11.sp, color = Color.White) }
                                }
                            } else {
                                Surface(
                                    shape = RoundedCornerShape(10.dp),
                                    color = LocalPill.current,
                                    modifier = Modifier.height(40.dp),
                                ) {
                                    Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Icon(Icons.AutoMirrored.Outlined.Article, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(14.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text(name, fontSize = 12.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Spacer(Modifier.width(6.dp))
                                        Box(
                                            Modifier.size(16.dp).clickable { onRemoveAttachment(index) },
                                            contentAlignment = Alignment.Center,
                                        ) { Text("×", fontSize = 12.sp, color = LocalMuted.current) }
                                    }
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                }
                OutlinedTextField(
                    text, { text = it },
                    /*
                     * Claude's phone composer says what a send will do: while a
                     * turn is in flight the line becomes 「将消息加入队列…」, so
                     * it is clear the words wait their turn instead of steering
                     * the running reply.
                     */
                    /*
                     * Claude's idle line reads 「输入 / 以使用命令」 - it teaches the
                     * slash commands right where they would be typed - and
                     * its own grey is 123,121,116, a step lighter than the
                     * muted used for labels elsewhere on the page.
                     */
                    placeholder = {
                        Text(
                            if (running) "将消息加入队列…" else "输入 / 以使用命令",
                            color = if (LocalBg.current == DarkBg) DarkMuted else Color(0xFF7B7974),
                        )
                    },
                    /*
                     * `.input`'s measurements: 13 over a 20 line-height, and
                     * the box's own 16/16/8 inset - the text starts where the
                     * desktop's does, and an empty composer is 60 tall rather
                     * than one line tall.
                     */
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, lineHeight = 20.sp, color = LocalText.current),
                    colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent),
                    shape = RoundedCornerShape(0.dp),
                    maxLines = 8,
                    // `.input`'s 60 is a minimum, not a height: the box grows
                    // with the text up to its own cap.
                    modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp),
                )
                // `.row`: 44 tall, 8 in from each edge, 4 between the controls.
                Row(
                    Modifier.fillMaxWidth().height(44.dp).padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    var plusMenu by remember { mutableStateOf(false) }
                    var skillPicker by remember { mutableStateOf(false) }
                    // Claude's + and mic both sit in a soft pill circle; the
                    // round button on the right is ink until there is something
                    // to send, then the theme's accent.
                    Box(
                        Modifier.size(36.dp).background(LocalPill.current, CircleShape).clickable(enabled = enabled) { plusMenu = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = "更多", tint = LocalText.current, modifier = Modifier.size(20.dp))
                        /*
                         * The desktop's plus menu, in the same order: files,
                         * then the terminal, then 追求目标 as a switch rather
                         * than a command, then the skills submenu. The phone had
                         * "new chat" and "photo" here and nothing else, so the
                         * two things the desktop's menu is actually for - aiming
                         * a turn at a goal, and reaching a skill by name - were
                         * unreachable from a tablet.
                         */
                        DropdownMenu(
                            expanded = plusMenu,
                            onDismissRequest = { plusMenu = false },
                            modifier = Modifier.width(272.dp).background(MaterialTheme.colorScheme.surface),
                        ) {
                            // The desktop's row opens the system file dialog and
                            // attaches what is picked. This one opened the
                            // repository browser instead - a reading surface, not
                            // a picker - so choosing a file looked like it did
                            // nothing at all. `onFiles` stays on the header menu,
                            // where browsing the project is what is wanted.
                            PlusRow(Icons.AutoMirrored.Outlined.Article, "添加照片和文件", enabled) { plusMenu = false; pickImages() }
                            PlusRow(Icons.Outlined.Code, "打开终端", enabled) { plusMenu = false; onTerminal() }
                            // `.plus-menu .rule`: 4 above and below, 6 at each end.
                            HorizontalDivider(Modifier.padding(horizontal = 6.dp, vertical = 4.dp), color = LocalMuted.current.copy(alpha = 0.12f))
                            // 追求目标: a switch, not a command - what is typed next
                            // becomes the goal and the turn is judged against it.
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 6.dp)
                                    .clip(RoundedCornerShape(11.dp))
                                    .clickable(enabled = enabled) { onToggleGoalMode() }
                                    .padding(horizontal = 6.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                /*
                                 * `.item.goal-row`: 6 above and below with 2
                                 * between the two lines; the label is the
                                 * menu's own 13 and the sub-line 11.5 over 15.
                                 */
                                Column(Modifier.weight(1f)) {
                                    Text("追求目标", fontSize = 13.sp, fontWeight = FontWeight(440), color = LocalText.current)
                                    Spacer(Modifier.height(2.dp))
                                    Text("持续推进，直到目标彻底达成", fontSize = 11.5.sp, lineHeight = 15.sp, color = LocalMuted.current, maxLines = 1)
                                }
                                Spacer(Modifier.width(10.dp))
                                GoalSwitch(on = goalMode)
                            }
                            // `.plus-menu .rule`: 4 above and below, 6 at each end.
                            HorizontalDivider(Modifier.padding(horizontal = 6.dp, vertical = 4.dp), color = LocalMuted.current.copy(alpha = 0.12f))
                            // MiMo's skill mark is a jigsaw piece on a 12 grid, and the
                            // row carries the submenu chevron.
                            PlusRow(
                                Icons.Outlined.Build,
                                "技能",
                                enabled && skills.isNotEmpty(),
                                path = "M6.2 2.5h2.3a1 1 0 0 1 1 1v1.2a1.3 1.3 0 1 1 0 2.6v1.2a1 1 0 0 1-1 1H7.3a1.3 1.3 0 1 0-2.6 0H3.5a1 1 0 0 1-1-1V7.3a1.3 1.3 0 1 0 0-2.6V3.5a1 1 0 0 1 1-1z",
                                pathViewBox = 12f,
                                chevron = true,
                            ) { plusMenu = false; skillPicker = true }
                        }
                    }
                    if (skillPicker) {
                        SkillPicker(
                            skills = skills,
                            onDismiss = { skillPicker = false },
                            onPick = { name ->
                                skillPicker = false
                                text = (if (text.isBlank()) "" else text.trimEnd() + " ") + "/$name "
                            },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    // The desktop's middle pill. It sat only in the settings
                    // sheet here, so a reader being asked too often had to leave
                    // the words they were writing to change it.
                    AccessPill(access0, onAccess, fullAllowed)
                    Spacer(Modifier.width(8.dp))
                    /*
                     * The ring, left of the model the way the desktop has it.
                     * Like the desktop, nothing is drawn until a turn has spent
                     * something: an empty conversation has nothing to measure.
                     */
                    if (contextUsed > 0) {
                        /*
                         * Pressing the ring keeps the figures up, as the
                         * desktop's tooltip does on a click: the ring alone
                         * says "somewhere here" and never how much.
                         */
                        var ctxCard by remember { mutableStateOf(false) }
                        Box {
                            Row(
                                Modifier.clip(RoundedCornerShape(9.dp)).clickable { ctxCard = true }.padding(3.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) { ContextRing(contextUsed, contextLimit, 18.dp) }
                            DropdownMenu(
                                expanded = ctxCard,
                                onDismissRequest = { ctxCard = false },
                                modifier = Modifier.width(220.dp).background(MaterialTheme.colorScheme.surface),
                            ) {
                                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                                    Text("上下文用量", fontSize = 12.sp, color = LocalMuted.current)
                                    Spacer(Modifier.height(4.dp))
                                    val pct = if (contextLimit > 0) Math.round(contextUsed * 100.0 / contextLimit).toInt() else 0
                                    Text(
                                        if (contextLimit > 0) "已用 $pct%（剩余 ${100 - pct}%）" else "已用 ${compactTokens(contextUsed)}",
                                        fontSize = 14.sp,
                                        color = LocalText.current,
                                    )
                                    if (contextLimit > 0) {
                                        Spacer(Modifier.height(2.dp))
                                        Text("已用 ${compactTokens(contextUsed)}，共 ${compactTokens(contextLimit)}", fontSize = 12.sp, color = LocalMuted.current)
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.width(8.dp))
                    }
                    Surface(
                        shape = RoundedCornerShape(17.dp),
                        color = LocalPill.current,
                        modifier = Modifier.clickable(enabled = enabled && onModel != {}) { onModel() },
                    ) {
                        // Claude's pill names the model and its effort
                        // ("Sonnet 5.5 中等"); ours names what this app has.
                        Text(modelLabel, fontSize = 13.sp, color = LocalText.current, modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    // Listening and transcribing own the round button: Claude
                    // turns it into the stop/timepiece while the microphone is
                    // open, so a second tap closes the recording.
                    if (transcribing) {
                        androidx.compose.material3.CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp,
                            color = LocalMuted.current,
                        )
                        Spacer(Modifier.width(14.dp))
                    }
                    Box(
                        Modifier.size(36.dp).background(if (listening) Color(0x1FE0574A) else LocalPill.current, CircleShape).clickable(enabled = !transcribing) { onMic() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            if (listening) Icons.Filled.Stop else Icons.Outlined.Mic,
                            contentDescription = if (listening) "结束录音" else "语音输入",
                            tint = if (listening) Color(0xFFE0574A) else LocalMuted.current,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    // Claude's round button is ink while the box is empty (a waveform on
                    // black) and takes the accent once there is something to send.
                    // The dark theme flips the ink to the paper colour; measured
                    // off Claude on the fold in both themes.
                    val hasWords = text.isNotBlank() || attachments.isNotEmpty()
                    /*
                     * The round button in three states, all sampled off Claude:
                     * idle-dark is the paper circle #F9F9F7 with the icon in
                     * ink; idle-light is the ink circle with a paper icon; and
                     * a box with something in it takes the washed ember in the
                     * light theme only (dark keeps the paper circle).
                     */
                    val dark = isSystemInDarkTheme()
                    /*
                     * Four states, sampled off Claude on the pad: a running turn
                     * takes the same soft pill as the + and the mic (240,239,236)
                     * with an ink rectangle in it - not the ink disc used for
                     * sending, which read as "press to send" while there was
                     * nothing to send.
                     */
                    val sendBg = when {
                        running -> LocalPill.current
                        hasWords && !dark -> Color(0xFFE1C0B3)
                        dark -> Color(0xFFF9F9F7)
                        else -> LocalText.current
                    }
                    val sendFg = when {
                        running -> LocalText.current
                        hasWords && !dark -> Color.White
                        dark -> Color(0xFF151515)
                        else -> LocalBg.current
                    }
                    Box(
                        /*
                         * `.send` is a 28 square with a 6 corner, not a circle:
                         * the desktop's send is a rounded tile, and a 44dp disc
                         * here read as a different control - the same size as
                         * the plus and the mic beside it, which are circles.
                         * The touch target stays 44 through the padding-free
                         * box; only the painted shape follows the desktop.
                         */
                        Modifier.size(44.dp).clickable(enabled = enabled && !transcribing) {
                            if (running) onStop()
                            else if (listening) onMic()
                            else if (text.isNotBlank() || attachments.isNotEmpty()) { onSend(text, attachments); text = "" }
                        },
                        contentAlignment = Alignment.Center,
                    ) {
                        /*
                         * The painted tile: 28 square with a 6 corner, the
                         * desktop's `.send`, with the mark at 16 - which is
                         * what the icon sizes on the reference row come to
                         * against a 28 box.
                         */
                        Box(
                            Modifier
                                .size(28.dp)
                                .background(sendBg, RoundedCornerShape(6.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                        if (running) {
                            // An outlined square, not a filled one: Claude's stop
                            // is a 1.5dp ink rectangle inside the soft circle.
                            Box(
                                Modifier
                                    .size(15.dp)
                                    .border(1.5.dp, sendFg, RoundedCornerShape(2.dp)),
                            )
                        } else if (transcribing) {
                            androidx.compose.material3.CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = sendFg,
                            )
                        } else if (listening) {
                            // MiMo's live capsule: the button becomes the stop
                            // square while a recording is in flight.
                            Box(Modifier.size(16.dp).background(sendFg, RoundedCornerShape(3.dp)))
                        } else if (text.isBlank() && attachments.isEmpty()) {
                            Icon(Icons.Outlined.GraphicEq, contentDescription = "语音输入", tint = sendFg, modifier = Modifier.size(20.dp))
                        } else {
                            Icon(Icons.Filled.ArrowUpward, contentDescription = "发送", tint = sendFg, modifier = Modifier.size(16.dp))
                        }
                        }
                    }
                }
            }
        }
        }
    }
}

/**
 * One tool call.
 *
 * Pulled out of the timeline so a run of calls can reuse it when it opens: the
 * row is identical whether it stands alone or sits inside a summary.
 */
/** The words of a step. Split out so a step and a bare reply draw them alike. */
@Composable
private fun StepBody(item: Item.Msg) {
    if (item.text.isBlank()) return
    Box(Modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 5.dp),
        ) {
            MarkdownBody(item.text, dark = LocalBg.current == DarkBg)
        }
    }
}

/** A folded run inside a step: the same summary row the timeline draws. */
@Composable
private fun RunRow(item: ToolRun) {
    var open by remember { mutableStateOf(false) }
    // `.hstep`, as ToolRow wears it: 23 in, 5 above and below, 14 over 22.4.
    Column(Modifier.padding(start = 23.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                runSummary(item),
                fontSize = 14.sp,
                lineHeight = 22.4.sp,
                color = LocalMuted.current,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = if (open) "收起" else "展开",
                tint = LocalMuted.current,
                modifier = Modifier.size(14.dp).graphicsLayer { rotationZ = if (open) 90f else 0f },
            )
        }
        if (open) for (call in item.items) ToolRow(call)
    }
}

@Composable
fun ToolRow(
    item: Item.Tool,
    /**
     * Where a delivered file opens, when this row may draw the cards. A row
     * drawn inside a folded run or a sheet passes nothing, so the card appears
     * once - under the reply, where the desktop puts it.
     */
    onOpenDelivered: ((String, String) -> Unit)? = null,
    root: String = "",
) {
    var open by remember { mutableStateOf(false) }
    // A call that is still going and one that broke read differently from one
    // that finished quietly.
    val failed = item.status == "error" || item.status == "failed"
    val busy = item.status == "running" || item.status == "pending" || item.status == "in_progress"
    val rowTint = when {
        failed -> MaterialTheme.colorScheme.error
        busy -> MaterialTheme.colorScheme.primary
        else -> LocalMuted.current
    }
    /*
     * `.hstep`: 14 over a 22.4 line, 5 above and below, indented 23 from the
     * step's rail. This drew 13 with 3 of padding and a 10 indent, which is
     * both a size and a rhythm off - the rows sat tighter than the prose they
     * sit between.
     */
    Column(Modifier.padding(start = 23.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            /*
             * No icon: Claude's own tool row is words and a chevron -
             * 「已使用 PowerShell ›」, 「正在读取 ›」 - at 53px of line height. A
             * glyph per call added a column of little pictures down the
             * transcript the original never had, and pushed the words away from
             * where they are read from.
             */
            Text(
                toolVerbOf(item.name, item.status) + if (item.title.isNotBlank()) " ${item.title}" else "",
                fontSize = 14.sp,
                lineHeight = 22.4.sp,
                fontWeight = FontWeight.Medium,
                color = if (failed || busy) rowTint else LocalMuted.current,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (item.output.isNotBlank()) {
                Icon(
                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    contentDescription = if (open) "收起" else "展开",
                    tint = LocalMuted.current,
                    modifier = Modifier.size(14.dp).graphicsLayer { rotationZ = if (open) 90f else 0f },
                )
            }
        }
        /*
         * `.hs-collapse`: the rows grow from nothing and fade in over 0.18s on
         * the same curve as the message entrance. The phone swapped the block
         * in at once, so a tool's output appeared as a jump rather than as the
         * row opening.
         */
        val reveal by animateFloatAsState(
            if (open && item.output.isNotBlank()) 1f else 0f,
            tween(durationMillis = 180, easing = CubicBezierEasing(0.2f, 0.7f, 0.2f, 1f)),
            label = "step-open",
        )
        if (open && item.output.isNotBlank()) {
            /*
             * A patch reads as one: added lines on a faint green, removed on a
             * faint red, hunk headers muted. The desktop draws a full diff
             * component; a phone row only has space for the colour, which is
             * the part that makes a patch scannable at all.
             */
            val patch = item.output.contains("\n@@") || item.output.startsWith("diff --git") || item.output.startsWith("@@")
            // The one renderer, so a tool's output and a diff card cannot drift.
            DiffLines(
                item.output,
                modifier = Modifier.padding(start = 22.dp, top = 2.dp, bottom = 4.dp).graphicsLayer { alpha = reveal },
                isPatch = patch,
                maxLines = 60,
                boxed = false,
            )
        }
        /*
         * What the call handed over, as cards. They sit outside the collapsible
         * block on purpose: a delivered file is the point of the call, and a
         * reader should not have to open 「展示文件」 to find what was presented.
         */
        if (onOpenDelivered != null && item.delivered.isNotEmpty()) {
            DeliveredCards(item.delivered, root, onOpenDelivered)
        }
    }
}

/**
 * A PDF, page by page.
 *
 * Android ships `PdfRenderer`, which turns a page into a bitmap; there is no
 * viewer widget, so the pages are drawn into a lazily-built column and scrolled.
 * That is what the desktop's pdf.js tab shows as well - the document, whole, one
 * page under the next - so the shape is the same even though the engine is not.
 *
 * The renderer and its parcel file are closed when the sheet goes: both hold a
 * file descriptor, and a tablet that opens three documents would otherwise run
 * out of them.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PdfViewer(name: String, file: java.io.File, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var pages by remember(file) { mutableStateOf(0) }
    var error by remember(file) { mutableStateOf<String?>(null) }

    // One renderer for the life of the sheet; each page is rendered on demand.
    val holder = remember(file) { arrayOfNulls<Any>(2) } // [PdfRenderer, ParcelFileDescriptor]
    DisposableEffect(file) {
        onDispose {
            runCatching { (holder[0] as? android.graphics.pdf.PdfRenderer)?.close() }
            runCatching { (holder[1] as? android.os.ParcelFileDescriptor)?.close() }
        }
    }
    LaunchedEffect(file) {
        runCatching {
            val pfd = android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
            val renderer = android.graphics.pdf.PdfRenderer(pfd)
            holder[0] = renderer
            holder[1] = pfd
            pages = renderer.pageCount
        }.onFailure { error = it.message ?: "无法打开" }
    }

    ModalBottomSheet(
        onDismissRequest = onClose,
        containerColor = MaterialTheme.colorScheme.background,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    name,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = LocalText.current,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (pages > 0) {
                    Text("$pages 页", fontSize = 12.sp, color = LocalMuted.current)
                    Spacer(Modifier.width(10.dp))
                }
                Box(Modifier.size(34.dp).clickable { onClose() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Close, contentDescription = "关闭", tint = LocalMuted.current, modifier = Modifier.size(16.dp))
                }
            }
            Spacer(Modifier.height(8.dp))
            when {
                error != null -> Text("打不开这个 PDF：$error", fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                pages == 0 -> Text("正在读取…", fontSize = 13.sp, color = LocalMuted.current)
                else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 620.dp)) {
                    items(pages) { index ->
                        PdfPage(holder[0] as? android.graphics.pdf.PdfRenderer, index)
                        Spacer(Modifier.height(10.dp))
                    }
                }
            }
        }
    }
}

/**
 * One page, drawn at the pane's width.
 *
 * The bitmap is built once per index and remembered by it; a page that scrolls
 * out is dropped and rebuilt from its index when it comes back, which keeps a
 * long document's memory bounded by what is on screen rather than by its length.
 */
@Composable
fun PdfPage(renderer: android.graphics.pdf.PdfRenderer?, index: Int) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val density = androidx.compose.ui.platform.LocalDensity.current
    val widthPx = with(density) { 340.dp.toPx() }.toInt()
    val bitmap = remember(renderer, index) {
        runCatching {
            renderer?.openPage(index)?.use { page ->
                val ratio = page.height.toFloat() / page.width.toFloat().coerceAtLeast(1f)
                val h = (widthPx * ratio).toInt().coerceIn(1, 4000)
                val image = android.graphics.Bitmap.createBitmap(widthPx, h, android.graphics.Bitmap.Config.ARGB_8888)
                val canvas = android.graphics.Canvas(image)
                canvas.drawColor(android.graphics.Color.WHITE)
                page.render(image, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                image
            }
        }.getOrNull()
    }
    if (bitmap != null) {
        androidx.compose.foundation.Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = "第 ${index + 1} 页",
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(Color.White),
            contentScale = ContentScale.FillWidth,
        )
    } else {
        Text("第 ${index + 1} 页读不出来", fontSize = 12.sp, color = LocalMuted.current)
    }
}

/**
 * An Office document, drawn by the WebView.
 *
 * The document was turned into one HTML page where the file is (see
 * `src/server/office/html.ts`), so this side has nothing to parse: a WebView
 * shows the page, which is the same arrangement the desktop has - a viewer that
 * renders, and a document turned into something renderable.
 *
 * The view is given the page as a string rather than a URL, and JavaScript is
 * off: the page is the converter's own output, it needs no script, and a reader
 * that never runs one cannot be made to by a document.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OfficeViewer(name: String, kind: String, html: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val dark = LocalBg.current == DarkBg
    ModalBottomSheet(onDismissRequest = onClose, containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    name,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = LocalText.current,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    kind.uppercase(),
                    fontSize = 11.sp,
                    color = LocalMuted.current,
                    modifier = Modifier
                        .background(LocalPill.current, RoundedCornerShape(6.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
                Spacer(Modifier.width(8.dp))
                Box(Modifier.size(34.dp).clickable { onClose() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Close, contentDescription = "关闭", tint = LocalMuted.current, modifier = Modifier.size(16.dp))
                }
            }
            Spacer(Modifier.height(8.dp))
            androidx.compose.ui.viewinterop.AndroidView(
                factory = { ctx ->
                    android.webkit.WebView(ctx).apply {
                        setBackgroundColor(if (dark) 0xFF151515.toInt() else 0xFFFFFEFD.toInt())
                        settings.javaScriptEnabled = false
                        settings.loadWithOverviewMode = true
                        settings.useWideViewPort = true
                        isVerticalScrollBarEnabled = false
                        // The page is handed over as a string with no base URL, so
                        // nothing it asks for can reach the network: its images are
                        // already data URLs.
                        loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(max = 640.dp),
            )
        }
    }
}

/**
 * What a reply handed over, as cards under it.
 *
 * `DeliveredFilesCard.vue`: a 38 tile in the file's own colour at a 9 corner,
 * the name at 14 over a 12 sub-line that carries the size, the whole row a
 * 12-cornered card on the raised surface with 11/14 of inset. Tapping one opens
 * the file the same way the artifacts page does.
 */
@Composable
fun DeliveredCards(files: List<DeliveredFile>, root: String, onOpen: (String, String) -> Unit) {
    if (files.isEmpty()) return
    for (file in files) {
        val badge = badgeOf(file.path)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 6.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(
                    1.dp,
                    if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8),
                    RoundedCornerShape(12.dp),
                )
                .clickable { onOpen(root, file.path) }
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(badge.fg.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Canvas(Modifier.size(20.dp)) { badge.glyph(this) }
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    file.name,
                    fontSize = 14.sp,
                    color = LocalText.current,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    listOfNotNull(badge.label, sizeLabel(file.size).takeIf { it.isNotBlank() }).joinToString(" · "),
                    fontSize = 12.sp,
                    color = LocalMuted.current,
                    maxLines = 1,
                )
            }
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = LocalMuted.current,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/** A file's size the way the desktop writes it: bytes, then KB and MB to one place. */
fun sizeLabel(bytes: Long): String = when {
    bytes <= 0L -> ""
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
}

/** One file a turn wrote, and how it changed. */
data class EditedFile(val path: String, val add: Int, val del: Int, val created: Boolean)

/** The tools whose calls change a file; the desktop's `EDITING` set. */
private val EDITING_TOOLS = setOf("edit", "write", "notebook_edit", "patch")

private val HUNK_HEADER = Regex("^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@")

/** One file's share of a patch, as the header and the hunk counts give it. */
private data class DiffCount(val file: String, val oldFile: String, val add: Int, val del: Int)

/**
 * Splits a unified diff and counts each file's lines the way
 * `src/shared/unified-diff.ts` does.
 *
 * Hunks are read by their own line counts rather than by the `+`/`-` prefixes:
 * a removed line that happens to read `-- x` is written `--- x`, and when the
 * added line after it reads `++ y` the pair looks exactly like the header of
 * the next file. Only the counts say it is still inside the hunk - which is
 * why the naive prefix tally this replaced produced a phantom file per such
 * line, and why the desktop's parser is written this way.
 */
private fun countDiff(diff: String): List<DiffCount> {
    val lines = diff.split("\n")
    val out = ArrayList<DiffCount>()
    var file: String? = null
    var oldFile = ""
    var add = 0
    var del = 0
    fun flush() {
        val name = file
        if (name != null && name.isNotBlank()) out.add(DiffCount(name, oldFile, add, del))
        add = 0
        del = 0
    }
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        if (line.startsWith("--- ") && lines.getOrNull(index + 1)?.startsWith("+++ ") == true) {
            flush()
            oldFile = line.substring(4).removePrefix("a/").trim()
            file = lines[index + 1].substring(4).removePrefix("b/").trim()
            index += 2
            continue
        }
        val match = HUNK_HEADER.find(line)
        if (match == null || file == null) {
            index++
            continue
        }
        val groups = match.groupValues
        var oldLeft = if (groups[2].isEmpty()) 1 else groups[2].toInt()
        var newLeft = if (groups[4].isEmpty()) 1 else groups[4].toInt()
        index++
        while (index < lines.size && (oldLeft > 0 || newLeft > 0)) {
            val body = lines[index]
            if (body.startsWith(" ")) {
                oldLeft--
                newLeft--
            } else if (body.startsWith("-")) {
                del++
                oldLeft--
            } else if (body.startsWith("+")) {
                add++
                newLeft--
            } else if (!body.startsWith("\\")) {
                break
            }
            index++
        }
    }
    flush()
    return out
}

/**
 * The files a call's recorded patch changed.
 *
 * `metadata.diff` is where the desktop reads them (`src/renderer/src/lib/
 * edited-files.ts`), and the phone used to look in `state.output` instead -
 * which carries the tool's one-line reply, not the change. Measured over the
 * 18 conversations on this machine: 1306 tool calls, 244 of them with a
 * `metadata.diff`, and not one with a patch in its output. That mismatch is
 * why the card never appeared at all rather than merely being miscounted.
 *
 * A call that ended in error is left out, the same test the desktop's card and
 * its undo both make: a row drawn here that the undo then skipped reported
 * fewer files than the reader had just been shown.
 */
fun editedOf(part: JSONObject): List<EditedFile> {
    if (part.optString("name") !in EDITING_TOOLS) return emptyList()
    val state = part.optJSONObject("state")
    val status = state?.optString("status").orEmpty().ifBlank { part.optString("status") }
    if (status == "error") return emptyList()
    val metadata = state?.optJSONObject("metadata") ?: part.optJSONObject("metadata") ?: return emptyList()
    val diff = metadata.optString("diff")
    if (diff.isBlank()) return emptyList()
    // What the call recorded about creating the file beats what the patch looks like.
    val recorded = if (metadata.has("created")) metadata.optBoolean("created") else null
    return countDiff(diff).map { section ->
        EditedFile(section.file, section.add, section.del, recorded ?: (section.oldFile == "/dev/null"))
    }
}

/**
 * Each turn's edits, gathered into one card the way `EditedFilesCard.vue` has
 * it - keyed by the key of the item that ends the turn.
 *
 * The desktop counts a turn, not a call: three edits in one reply are one card
 * saying 「已编辑 3 个文件」, and the phone drawing one per call was three cards
 * stacked under the same paragraph. A turn starts at the reader's own message,
 * which is also where the desktop's `turns` starts one.
 *
 * Only the words and the calls move the turn's end, because that is where the
 * desktop puts the card: ahead of the error card, the delivered files and the
 * media strip that follow the same reply. Letting a gap or a failure set it too
 * put the card after the failure notice, which reads as if the files had been
 * edited by the thing that broke.
 */
/**
 * A turn's edits, plus what the server needs to take them back.
 *
 * `messages` is the turn's assistant message ids, which is what
 * `session.revertTurn` names the turn by (`EditedFilesCard.vue` passes
 * `turn.messageIDs`); `reverted` is the flag the server writes on the turn's
 * last message once 撤销 has actually moved something.
 */
data class TurnEdit(
    val files: List<EditedFile>,
    val messages: List<String>,
    val reverted: Boolean,
    /**
     * The patches the turn's own calls recorded, joined - what 审阅 shows.
     *
     * The desktop prefers the repository's current diff and falls back to this
     * (`recordedPatch`), because a turn's own record survives a later commit.
     * The phone asks git for nothing here: `git.diffFiles` is a second round
     * trip per card, and the recorded patch is the change the reader is looking
     * at anyway.
     */
    val patch: String,
)

fun turnEdits(items: List<Item>): Map<String, TurnEdit> {
    val out = LinkedHashMap<String, TurnEdit>()
    val byPath = LinkedHashMap<String, EditedFile>()
    val messages = mutableListOf<String>()
    val patches = mutableListOf<String>()
    var last = ""
    var reverted = false
    fun flush() {
        if (last.isNotEmpty() && byPath.isNotEmpty()) {
            out[last] = TurnEdit(byPath.values.toList(), messages.toList(), reverted, patches.joinToString("\n"))
        }
        byPath.clear()
        messages.clear()
        patches.clear()
        reverted = false
    }
    for (item in items) {
        if (item is Item.Msg && item.role == "user") {
            flush()
            continue
        }
        if (item is Item.Msg || item is Item.Tool) last = item.key
        if (item is Item.Msg && item.role != "user") {
            messages.add(item.id)
            if (item.reverted) reverted = true
        }
        if (item is Item.Tool) {
            for (file in editedOf(item.raw)) {
                val known = byPath[file.path]
                byPath[file.path] = if (known == null) file else known.copy(add = known.add + file.add, del = known.del + file.del)
            }
            if (item.name in EDITING_TOOLS && item.status != "error") {
                val metadata = item.raw.optJSONObject("state")?.optJSONObject("metadata")
                    ?: item.raw.optJSONObject("metadata")
                metadata?.optString("diff")?.takeIf { it.isNotBlank() }?.let { patches.add(it) }
            }
        }
    }
    flush()
    return out
}

/** The item keys each folded row covers, so a card finds the row its turn ends on. */
private fun keysByRow(rows: List<Any>): List<Set<String>> {
    fun keysOf(value: Any): Set<String> = when (value) {
        is Item -> setOf(value.key)
        is ToolRun -> value.items.map { it.key }.toSet()
        is Step -> buildSet {
            (value.body as? Item)?.let { add(it.key) }
            for (call in value.calls) addAll(keysOf(call))
        }
        else -> emptySet()
    }
    return rows.map { keysOf(it) }
}

/**
 * The turn's edits as one card, the way the desktop draws them.
 *
 * `EditedFilesCard.vue`: a 10 corner on the page's own fill, a 40 plate holding
 * a 19 mark - a sheet with a plus over a minus when several files changed, a
 * plus when one was created, a pencil otherwise - then the title and the two
 * counts. Several files also list their rows under a hairline, three at a time
 * with the rest behind 「再显示 N 个文件」.
 *
 * The counts here are fixed greens and reds whatever the theme, which is what
 * MiMo does on this card - not the diff view's theme-aware inks.
 */
@Composable
fun EditedCard(
    turn: TurnEdit,
    root: String,
    onOpen: ((String, String) -> Unit)?,
    /** Offered only where the server can act on it, and not in a side conversation. */
    onRevert: (() -> Unit)? = null,
    onReview: (() -> Unit)? = null,
) {
    val files = turn.files
    if (files.isEmpty()) return
    val dark = LocalBg.current == DarkBg
    val surface = if (dark) Color(0xFF181818) else Color(0xFFFFFEFD)
    val line = if (dark) Color(0xFF2E2E2E) else Color(0xFFF0EBE5)
    val plate = if (dark) Color(0xFF2E2E2E) else Color(0xFFF0F0F2)
    val statMuted = if (dark) Color(0xFFB8B8B8) else Color(0x99151C13)
    /*
     * Taken back: the transcript stays and only the files moved, so the card
     * says so in place of its counts. It keeps its own surface, dimmed.
     */
    if (turn.reverted) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 12.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(plate)
                .alpha(0.85f)
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MiIcon(
                "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8",
                modifier = Modifier.size(16.dp),
                strokeWidth = 1.7f,
                tint = statMuted,
            )
            Spacer(Modifier.width(9.dp))
            Text("已撤销 ${files.size} 个文件的改动", fontSize = 14.sp, color = statMuted)
        }
        return
    }
    val add = files.sumOf { it.add }
    val del = files.sumOf { it.del }
    val single = files.singleOrNull()
    var expanded by remember(files.size) { mutableStateOf(false) }
    var confirming by remember(files.size) { mutableStateOf(false) }
    val shown = if (expanded) files else files.take(3)
    fun relative(path: String): String {
        val base = root.trimEnd('/', '\\')
        if (base.isEmpty()) return path
        if (!path.lowercase().startsWith(base.lowercase())) return path
        val next = path.getOrNull(base.length)
        return if (next == '/' || next == '\\') path.substring(base.length + 1) else path
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(surface)
            .border(1.dp, line, RoundedCornerShape(10.dp)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(
                    if (single != null && onOpen != null) {
                        Modifier.clickable { onOpen(root, single.path) }
                    } else {
                        Modifier
                    },
                )
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(plate),
                contentAlignment = Alignment.Center,
            ) {
                MiIcon(
                    when {
                        files.size > 1 -> "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM12 7.5v5M9.5 10h5M9.5 16h5"
                        single!!.created -> "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5M12 11v6M9 14h6"
                        else -> "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M14 3v5h5v2M19.4 13.6a1.9 1.9 0 0 1 0 2.7L15 20.7l-3 .8.8-3 4.4-4.4a1.9 1.9 0 0 1 2.2-.5Z"
                    },
                    modifier = Modifier.size(19.dp),
                    strokeWidth = 1.7f,
                    tint = LocalMuted.current,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                if (single != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("已编辑 ", fontSize = 14.sp, lineHeight = 20.sp, color = LocalText.current)
                        Text(
                            single.path.substringAfterLast('/').substringAfterLast('\\'),
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            color = LocalText.current,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                } else {
                    Text(
                        "已编辑 ${files.size} 个文件",
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        color = LocalText.current,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (add > 0 || del > 0) {
                Spacer(Modifier.width(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("+$add", fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = Color(0xFF1A7F37))
                    Text("-$del", fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = Color(0xFFE5484D))
                }
            }
            /*
             * 撤销 and 审阅, as the desktop offers them behind the counts. The
             * revert asks first: it cannot be undone, and the question is the
             * desktop's own sentence (`stream.confirmRevert`).
             */
            if (onRevert != null || onReview != null) {
                Spacer(Modifier.width(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (onRevert != null) {
                        Row(
                            Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { confirming = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("撤销", fontSize = 14.sp, lineHeight = 20.sp, color = LocalText.current)
                            Spacer(Modifier.width(5.dp))
                            MiIcon(
                                "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 1.8f,
                                tint = LocalText.current,
                            )
                        }
                    }
                    if (onReview != null) {
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (dark) Color(0xFF181818) else Color(0xFFFFFEFD))
                                .border(1.dp, line, RoundedCornerShape(8.dp))
                                .clickable { onReview() }
                                .padding(horizontal = 11.dp, vertical = 4.dp),
                        ) {
                            Text("审阅", fontSize = 14.sp, lineHeight = 20.sp, color = LocalText.current)
                        }
                    }
                }
            }
        }
        /*
         * The question before taking a turn back - the desktop's own card, in
         * its orange tint: an orange edge on both themes, since what it asks
         * cannot be undone.
         */
        if (confirming) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(12.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0x0FFF6A2B))
                    .border(1.dp, Color(0x59FF6A2B), RoundedCornerShape(12.dp))
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                Row {
                    MiIcon(
                        "M12 2 3 7v6c0 5 3.8 8.5 9 9 5.2-.5 9-4 9-9V7ZM12 8v4M12 16h.01",
                        modifier = Modifier.padding(top = 1.dp).size(18.dp),
                        strokeWidth = 1.8f,
                        tint = Color(0xFFFF6A2B),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "确定撤销 ${files.size} 个文件的改动？已跟踪文件仅撤销本回合的编辑（保留之前几轮的改动），新增文件将被删除，不可恢复。",
                        fontSize = 14.sp,
                        lineHeight = 21.7.sp,
                        color = LocalText.current,
                    )
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (dark) Color(0xFFECECEC) else Color(0xFF151C13))
                            .clickable { confirming = false; onRevert?.let { it() } }
                            .padding(horizontal = 18.dp, vertical = 7.dp),
                    ) {
                        Text(
                            "确定撤销",
                            fontSize = 13.sp,
                            color = if (dark) Color(0xFF151C13) else Color.White,
                        )
                    }
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (dark) Color(0xFF181818) else Color(0xFFFFFEFD))
                            .border(1.dp, line, RoundedCornerShape(8.dp))
                            .clickable { confirming = false }
                            .padding(horizontal = 18.dp, vertical = 7.dp),
                    ) {
                        Text("取消", fontSize = 13.sp, color = LocalText.current)
                    }
                }
            }
        }
        if (files.size > 1) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(line))
                Spacer(Modifier.height(2.dp))
                for (file in shown) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .then(if (onOpen != null) Modifier.clickable { onOpen(root, file.path) } else Modifier)
                            .padding(horizontal = 9.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            relative(file.path),
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            color = statMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(12.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("+${file.add}", fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = Color(0xFF1A7F37))
                            Text("-${file.del}", fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = Color(0xFFE5484D))
                        }
                    }
                }
                if (files.size > 3) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(6.dp))
                            .clickable { expanded = !expanded }
                            .padding(horizontal = 1.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (expanded) "收起" else "再显示 ${files.size - 3} 个文件",
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            color = LocalText.current,
                        )
                        Spacer(Modifier.width(6.dp))
                        MiIcon(
                            if (expanded) "m6 15 6-6 6 6" else "m6 9 6 6 6-6",
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 1.8f,
                            tint = LocalText.current,
                        )
                    }
                }
                Spacer(Modifier.height(2.dp))
            }
        }
    }
}
