package com.mcode.remote

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Stop
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
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Mic
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
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.BasicTextField
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
private val Ember = Color(0xFFD97757)
private val DotBlue = Color(0xFF3B82F6)

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
    data class Msg(val id: String, val role: String, var text: String, val images: List<String> = emptyList()) : Item() { override val key = "msg.$id" }
    /*
     * One tool call, the way the desktop's step list draws it: a verb that
     * says where the call is, and what it was about (`title`). The phone used
     * to print `· read completed`, which told the reader nothing.
     */
    data class Tool(val uid: String, val name: String, val status: String, val output: String, val title: String = "") : Item() { override val key = "tool.$uid" }
    /*
     * A permission request, carried whole: the card decides what to show from
     * the request itself (its command or subject, whether it carries a diff,
     * whether it is a delete that must be asked every time), the way the
     * desktop's PermissionDialog does. Passing a pre-flattened string lost the
     * diff and the forced flag.
     */
    data class Perm(val requestId: String, val request: JSONObject, val queueTotal: Int = 1) : Item() {
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

data class SessionRow(val id: String, val title: String, val running: Boolean, val updated: Long, val directory: String = "", val model: String = "", val agent: String = "build", val effort: String = "none")

class RemoteClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var ws: okhttp3.WebSocket? = null

    var onFrame: (JSONObject) -> Unit = {}
    var onState: (Boolean) -> Unit = {}

    // Responses are matched to their request by id; anyone waiting registers
    // here before sending. A concurrent map because onMessage runs on OkHttp
    // threads while the registration happens on the main thread.
    private val waiters = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.CompletableDeferred<JSONObject>>()

    fun awaitResponse(id: String): kotlinx.coroutines.CompletableDeferred<JSONObject> {
        val deferred = kotlinx.coroutines.CompletableDeferred<JSONObject>()
        waiters[id] = deferred
        return deferred
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
                    onFrame(frame)
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
        darkColorScheme(background = bg, surface = DarkSurface, onBackground = DarkText, onSurface = DarkText, primary = Ember, secondary = DarkPill, onSecondary = DarkText, surfaceVariant = DarkPill, onSurfaceVariant = DarkMuted, outline = DarkLine)
    } else {
        lightColorScheme(background = bg, surface = CreamSurface, onBackground = Ink, onSurface = Ink, primary = Ember, secondary = CreamPill, onSecondary = Ink, surfaceVariant = CreamPill, onSurfaceVariant = InkMuted, outline = CreamLine)
    }
    CompositionLocalProvider(
        LocalBg provides bg,
        LocalSurface provides surface,
        LocalText provides text,
        LocalMuted provides muted,
        LocalPill provides pill,
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
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    fun openDrawer() = scope.launch { drawerState.open() }
    fun closeDrawer() = scope.launch { drawerState.close() }
    var search by remember { mutableStateOf("") }
    var runningOnly by remember { mutableStateOf(false) }
    var privacy by remember { mutableStateOf(false) }
    var projectFilter by remember { mutableStateOf<String?>(null) }
    var showTasks by remember { mutableStateOf(false) }
    var showProjects by remember { mutableStateOf(false) }
    var showScheduled by remember { mutableStateOf(false) }
    var sheetTarget by remember { mutableStateOf<SessionRow?>(null) }
    var renameTarget by remember { mutableStateOf<SessionRow?>(null) }
    var deleteTarget by remember { mutableStateOf<SessionRow?>(null) }
    var voiceText by remember { mutableStateOf<String?>(null) }
    /** The turn whose long-press sheet is open (复制 / 从此处分支). */
    var messageTarget by remember { mutableStateOf<Item.Msg?>(null) }
    var modelPicker by remember { mutableStateOf(false) }
    var providers by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var showUsage by remember { mutableStateOf(false) }
    var usageSummary by remember { mutableStateOf<JSONObject?>(null) }
    /** Parked permission requests per session, replayed from session.list. */
    val pendingPerms = remember { java.util.concurrent.ConcurrentHashMap<String, MutableList<JSONObject>>() }
    /** Parked question cards per session, replayed from question.list. */
    val pendingQuestions = remember { java.util.concurrent.ConcurrentHashMap<String, MutableList<JSONObject>>() }
    /** Bumped whenever the parked maps change, so the replay effect re-runs. */
    var replayTick by remember { mutableStateOf(0) }
    val context = androidx.compose.ui.platform.LocalContext.current

    /** Pending photo attachments: {"path","mime","data"(base64)} ready for session.prompt. */
    val attachments = remember { mutableStateListOf<JSONObject>() }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris ->
        for (uri in uris) try {
            val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
            val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: continue
            val name = uri.lastPathSegment?.substringAfterLast('/') ?: "photo.jpg"
            attachments.add(JSONObject().put("path", name).put("mime", mime).put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)))
        } catch (_: Exception) {}
        if (uris.isNotEmpty()) Toast.makeText(context, "已附上 ${uris.size} 张图片", Toast.LENGTH_SHORT).show()
    }
    fun pickImages() {
        runCatching { imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
            .onFailure { Toast.makeText(context, "无法打开照片选择器", Toast.LENGTH_SHORT).show() }
    }

    val sessions = remember { mutableStateListOf<SessionRow>() }
    val items = remember { mutableStateListOf<Item>() }
    val messageIndex = remember { mutableStateMapOf<String, Int>() }
    var currentSession by remember { mutableStateOf<String?>(null) }
    var cursor by remember { mutableStateOf(0L) }
    /** Counts selections, so a history reply for an abandoned one is dropped. */
    var selectSeq by remember { mutableStateOf(0) }
    /** Each streamed part's kind, from the `message.part.updated` before its deltas. */
    val partKinds = remember { java.util.HashMap<String, String>() }

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
        return kotlinx.coroutines.withTimeout(timeoutMs) { deferred.await() }
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


    fun respondPerm(requestId: String, response: String) {
        scope.launch { rpc(JSONObject().put("type", "permission.respond").put("requestID", requestId).put("response", response)) }
    }

    /**
     * A refusal with a reason: the server hands the sentence to the model, so
     * it knows what to do differently rather than just that it was stopped.
     */
    fun respondPermReason(requestId: String, reason: String) {
        val req = JSONObject().put("type", "permission.respond").put("requestID", requestId).put("response", "reject")
        if (reason.isNotBlank()) req.put("reason", reason)
        scope.launch { rpc(req) }
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

    fun loadUsage() {
        usageSummary = null
        scope.launch {
            try {
                val reply = rpc(JSONObject().put("type", "usage.summary").put("days", 30))
                usageSummary = reply.optJSONObject("data")?.optJSONObject("summary")
            } catch (e: Exception) {
                println("[remote] usage.summary failed: $e")
            }
        }
    }

    fun answerQuestion(requestId: String, answer: List<String>) {
        scope.launch {
            try {
                rpc(JSONObject().put("type", "question.reply").put("requestID", requestId).put("answers", org.json.JSONArray().put(org.json.JSONArray(answer))))
            } catch (e: Exception) {
                println("[remote] question.reply failed: $e")
            }
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
                if (part.optString("type") == "text") text.append(part.optString("text")).append("\n")
            }
        }
        val known = messageIndex[id]
        /*
         * A turn is under way while its reply is unfinished, which is the same
         * rule the desktop uses: the phone had no notion of a running turn at
         * all, so the working line and the stop button never appeared.
         */
        if (role == "assistant" && id.isNotBlank()) {
            val finished = message.optString("finish").isNotBlank() || message.optJSONObject("time")?.optLong("completed", 0L)?.let { it > 0L } == true
            setRunning(sessionID, !finished)
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
                items[known] = existing.copy(text = next, images = images)
            }
        } else {
            val body = text.toString().trim()
            if (body.isNotEmpty() || role == "user" || images.isNotEmpty()) {
                items.add(Item.Msg(id, role, body.ifEmpty { if (images.isEmpty()) "…" else "" }, images))
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
                val row = Item.Tool(uid, part.optString("name", "tool"), status, output.replace(Regex("<[^>]+>"), "").lineSequence().firstOrNull()?.take(90) ?: "", toolTitleOf(part))
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
    fun appendDelta(sessionID: String, messageID: String, partID: String, text: String) {
        if (sessionID != currentSession || messageID.isBlank() || text.isEmpty()) return
        if (partKinds[partID] == "reasoning") return
        val known = messageIndex[messageID]
        if (known != null && known in items.indices) {
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
        if (partID.isNotBlank()) partKinds[partID] = part.optString("type")
        val known = messageIndex[messageID] ?: return
        val existing = items[known]
        if (existing !is Item.Msg) return
        when (part.optString("type")) {
            "text" -> items[known] = existing.copy(text = part.optString("text"))
            "tool" -> {
                // Same rule as a whole message: a call streams in many times,
                // so the row is found by its call id and replaced in place.
                val callID = part.optString("callID").ifEmpty { part.optString("id") }
                val uid = if (callID.isNotBlank()) callID else java.util.UUID.randomUUID().toString()
                val status = part.optJSONObject("state")?.optString("status", "")?.ifEmpty { null } ?: part.optString("status", "")
                val output = part.optString("output").ifEmpty { part.optJSONObject("state")?.optString("output", "") ?: "" }
                val row = Item.Tool(uid, part.optString("name", "tool"), status, output.replace(Regex("<[^>]+>"), "").lineSequence().firstOrNull()?.take(90) ?: "", toolTitleOf(part))
                val at = items.indexOfFirst { it is Item.Tool && it.uid == uid }
                if (at >= 0) items[at] = row else items.add(row)
            }
        }
    }

    fun select(id: String?) {
        currentSession = id
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
            val res = runCatching { deferred.await() }.getOrNull() ?: return@launch
            if (seq != selectSeq) return@launch
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
    fun newSession() {
        scope.launch {
            try {
                val reply = rpc(JSONObject().put("type", "session.create").put("title", "来自手机"))
                val sid = reply.optJSONObject("data")?.optJSONObject("session")?.optString("id").orEmpty()
                if (sid.isNotBlank()) select(sid)
            } catch (e: Exception) {
                println("[remote] session.create failed: $e")
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
                        sessions.add(SessionRow(sid, s.optString("title", sid), sid in running, s.optLong("updated", 0), s.optString("directory", ""), s.optJSONObject("model")?.optString("model", "") ?: "", s.optString("agent", "build"), s.optString("effort", "none")))
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
                        val title = s.optString("title", sid)
                        val updated = s.optLong("updated", 0)
                        val row = sessions.find { it.id == sid }
                        val directory = s.optString("directory", "")
                        val model = s.optJSONObject("model")?.optString("model", "") ?: ""
                        val agent = s.optString("agent", "build")
                        val effort = s.optString("effort", "none")
                        if (row != null) sessions[sessions.indexOf(row)] = row.copy(title = title, updated = updated, directory = directory, model = model, agent = agent, effort = effort)
                        else sessions.add(SessionRow(sid, title, false, updated, directory, model, agent, effort))
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
                    "session.deleted" -> {
                        val gone = event.optString("sessionID")
                        sessions.removeAll { it.id == gone }
                        if (currentSession == gone) {
                            currentSession = null
                            items.clear()
                            messageIndex.clear()
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
                }
            }
        }
    }

    client.onState = { up ->
        connected = up
        if (up) connectedOnce = true
    }
    client.onFrame = { f -> handle(f) }

    LaunchedEffect(Unit) {
        if (autoUrl.isNotBlank() && autoToken.isNotBlank()) client.connect(autoUrl, autoToken)
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

    // Claude keeps the single-pane layout in portrait even on the big inner
    // screen; only the expanded width class (the fold in landscape) goes two-pane.
    val wide = widthSize >= WindowWidthSizeClass.Expanded
    val empty = items.isEmpty()

    // 项目/运行中过滤后的列表；模型 pill 显示当前会话的真实模型。
    val visibleSessions = sessions.filter { (projectFilter == null || it.directory == projectFilter) && (!runningOnly || it.running) }
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
    val currentModelLabel = if (effortLabel.isNotEmpty()) "$displayModel $effortLabel" else displayModel

    val inputBar: @Composable () -> Unit = {
        InputCapsule(
            enabled = currentSession != null,
            modelLabel = currentModelLabel,
            onMic = { startVoice() },
            listening = recording != null,
            transcribing = voiceBusy,
            inject = voiceText,
            onInjected = { voiceText = null },
            onModel = { loadProviders(); modelPicker = true },
            running = sessions.find { it.id == currentSession }?.running == true,
            attachments = attachments.toList(),
            onRemoveAttachment = { attachments.removeAt(it) },
            pickImages = { pickImages() },
            onSend = { text, atts ->
                // steer only joins a running turn; an idle session gets a
                // plain prompt or the server ignores the message outright.
                val sid = currentSession!!
                val req = JSONObject().put("type", "session.prompt").put("sessionID", sid).put("text", text)
                if (atts.isNotEmpty()) req.put("attachments", org.json.JSONArray(atts.toList()))
                if (sessions.find { it.id == sid }?.running == true) req.put("delivery", "steer")
                request(req)
                // The round button turns into stop the moment the prompt
                // leaves, the way Claude's does, rather than waiting for the
                // first reply part to come back.
                setRunning(sid, true)
                attachments.clear()
            },
            onStop = { currentSession?.let { request(JSONObject().put("type", "session.abort").put("sessionID", it)) } },
            onNew = { newSession() },
        )
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
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
                    onProjects = { showProjects = true; closeDrawer() },
                    onScheduled = { showScheduled = true; closeDrawer() },
                    onTasks = { showTasks = true; closeDrawer() },
                    onUsage = { loadUsage(); showUsage = true; closeDrawer() },
                    // The drawer's search closes the drawer and focuses the
                    // list's field; on a phone the list is the page behind it.
                    onSearch = { closeDrawer() },
                    onSeeAll = { openDrawer() },
                    onCode = { closeDrawer() },
                    onLongPress = { sheetTarget = it },
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
            Row(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))) {
                /*
                 * Claude's split is 900 of 3408 px on the pad - 26.4% - not the
                 * 42% this used to take. Both panes share the page's own colour
                 * and no rule runs between them; only the composer's white card
                 * marks where the conversation begins.
                 */
                Column(Modifier.weight(0.2641f).fillMaxHeight().fillMaxWidth()) {
                    Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                    Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        /*
                         * Claude's list header: menu at the far left, the title
                         * centred, the two glyphs at the right. They are plain
                         * 36dp targets rather than IconButtons, whose 48dp
                         * minimum width ate the column and left the title one
                         * character wide.
                         */
                        Box(Modifier.size(44.dp).clickable { openDrawer() }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Menu, contentDescription = "菜单", tint = LocalText.current, modifier = Modifier.size(20.dp))
                        }
                        Text(
                            "最近记录",
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Medium,
                            color = LocalText.current,
                            maxLines = 1,
                            softWrap = false,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            modifier = Modifier.weight(1f),
                        )
                        Box(Modifier.size(38.dp).clickable { runningOnly = !runningOnly }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Tune, contentDescription = "筛选", tint = LocalText.current, modifier = Modifier.size(18.dp))
                        }
                        Box(Modifier.size(38.dp).clickable { showTasks = true }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Checklist, contentDescription = "任务", tint = LocalText.current, modifier = Modifier.size(18.dp))
                        }
                    }
                    OutlinedTextField(
                        search, { search = it },
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp).height(45.dp),
                        placeholder = { Text("搜索", color = LocalMuted.current, fontSize = 14.sp) },
                        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(17.dp)) },
                        shape = RoundedCornerShape(14.dp),
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                        // Claude's search sits on white with a hairline pill
                        // outline, not on the page's own colour with none.
                        colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = LocalField.current, focusedContainerColor = LocalField.current, unfocusedBorderColor = LocalFieldLine.current, focusedBorderColor = LocalFieldLine.current),
                        singleLine = true,
                    )
                        Spacer(Modifier.height(6.dp))
                        SessionList(visibleSessions, currentSession, search, onSelect = { select(it) }, compact = false, modifier = Modifier.weight(1f).fillMaxWidth(), onLongPress = { sheetTarget = it })
                        // Claude parks a black "new chat" pill at the foot of
                        // the list column. It is laid out after the list, so the
                        // list gets the space first and the pill never covers a
                        // row (the list's own bottom padding leaves room too).
                        Surface(
                            shape = RoundedCornerShape(24.dp),
                            color = LocalText.current,
                            modifier = Modifier.padding(top = 8.dp, bottom = 10.dp).align(Alignment.CenterHorizontally).clickable {
                                newSession()
                            },
                        ) {
                            Row(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("+", fontSize = 16.sp, color = LocalBg.current)
                                Spacer(Modifier.width(6.dp))
                                Text("新建会话", fontSize = 14.sp, color = LocalBg.current)
                            }
                        }
                    }
                    Column(Modifier.weight(0.7359f).fillMaxHeight().fillMaxWidth()) {
                        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            /*
                             * Claude's conversation header: a back arrow at the
                             * pane's left edge, the title centred with what the
                             * conversation is attached to under it, then the
                             * clock and the overflow at the right.
                             */
                            Box(Modifier.size(44.dp).clickable { select(null) }, contentAlignment = Alignment.Center) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(20.dp))
                            }
                            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
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
                            Box(Modifier.size(40.dp).clickable { showTasks = true }, contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.Schedule, contentDescription = "任务", tint = LocalText.current, modifier = Modifier.size(19.dp))
                            }
                            IconButton({ privacy = !privacy }, Modifier.size(40.dp)) { GhostGlyph(active = privacy, size = 21.dp) }
                        }
                        // The conversation pane, and only it, rides above the IME.
                        Column(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.ime.only(WindowInsetsSides.Bottom))) {
                            if (empty) {
                                WelcomePane(withInput = true, inputBar = inputBar, inputAtBottom = true)
                            } else {
                                Column(Modifier.fillMaxSize()) {
                                    Box(Modifier.weight(1f)) { Timeline(items, Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp), running = sessions.find { it.id == currentSession }?.running == true, onPerm = ::respondPerm, onPermReason = ::respondPermReason, onAnswer = ::answerQuestion, onMessage = { messageTarget = it }) }
                                    inputBar()
                                }
                            }
                        }
                    }
                }
        } else {
            if (empty) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    AppTopBar(filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onPrivacy = { privacy = !privacy })
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        WelcomePane(withInput = true, inputBar = inputBar)
                    }
                    Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)))
                }
            } else {
                Scaffold(
                    containerColor = MaterialTheme.colorScheme.background,
                    topBar = { AppTopBar(filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onPrivacy = { privacy = !privacy }) },
                    bottomBar = {
                        Column {
                            inputBar()
                            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)))
                        }
                    },
                ) { padding ->
                    Box(Modifier.padding(padding).fillMaxSize()) { Timeline(items, Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp), running = sessions.find { it.id == currentSession }?.running == true, onPerm = ::respondPerm, onPermReason = ::respondPermReason, onAnswer = ::answerQuestion, onMessage = { messageTarget = it }) }
                }
            }
        }
    }

    /* ---- 功能面板：任务 / 项目 / 定时任务 / 会话长按 / 重命名 ---- */
    if (showTasks) {
        ModalBottomSheet(onDismissRequest = { showTasks = false }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
                Text("进行中的任务", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                Spacer(Modifier.height(12.dp))
                val running = sessions.filter { it.running }
                if (running.isEmpty()) {
                    Text("没有正在运行的任务", fontSize = 14.sp, color = LocalMuted.current)
                } else {
                    for (r in running) {
                        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(r.title, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (r.directory.isNotBlank()) Text(r.directory.substringAfterLast('\\').substringAfterLast('/'), fontSize = 11.sp, color = LocalMuted.current, maxLines = 1)
                            }
                            TextButton({ request(JSONObject().put("type", "session.abort").put("sessionID", r.id)) }) { Text("停止", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
            }
        }
    }
    if (showProjects) {
        ModalBottomSheet(onDismissRequest = { showProjects = false }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
                Text("项目", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                Spacer(Modifier.height(12.dp))
                val projects = sessions.map { it.directory }.filter { it.isNotBlank() }.distinct().sorted()
                Row(Modifier.fillMaxWidth().clickable { projectFilter = null; showProjects = false }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Folder, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("全部项目", fontSize = 15.sp, color = LocalText.current)
                    Spacer(Modifier.weight(1f))
                    if (projectFilter == null) Icon(Icons.Outlined.Check, contentDescription = null, tint = Ember)
                }
                for (dir in projects) {
                    Row(Modifier.fillMaxWidth().clickable { projectFilter = dir; showProjects = false }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Folder, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(dir.substringAfterLast('\\').substringAfterLast('/'), fontSize = 15.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(dir, fontSize = 11.sp, color = LocalMuted.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (projectFilter == dir) Icon(Icons.Outlined.Check, contentDescription = null, tint = Ember)
                    }
                }
                if (projects.isEmpty()) Text("会话还没有目录信息", fontSize = 13.sp, color = LocalMuted.current)
            }
        }
    }
    if (showScheduled) {
        ModalBottomSheet(onDismissRequest = { showScheduled = false }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
                Text("定时任务", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                Spacer(Modifier.height(12.dp))
                Text("MCode 还没有定时任务。桌面端以后提供自动化时，它们会出现在这里。", fontSize = 14.sp, color = LocalMuted.current)
            }
        }
    }
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
    deleteTarget?.let { row ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
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

    /* ---- 模型选择：每个可用 provider 一节，逐行切 session.model ---- */
    /* ---- 用量：30 天总计、按天、按模型（对齐桌面设置里的用量页） ---- */
    if (showUsage) {
        ModalBottomSheet(onDismissRequest = { showUsage = false }, containerColor = MaterialTheme.colorScheme.background) {
            UsageSheet(summary = usageSummary)
        }
    }

    if (modelPicker) {
        ModalBottomSheet(onDismissRequest = { modelPicker = false }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
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
                                            println("[remote] session.model failed: $e")
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
            SparkMark(Modifier.size(36.dp))
            Spacer(Modifier.height(14.dp))
            Text(greeting(), fontSize = 18.sp, fontWeight = FontWeight.Normal, color = LocalText.current)
        } else {
            SparkMark(Modifier.size(46.dp))
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
            // Claude floats a small language pill at the composer's right, level
            // with its lower half: 40dp by 33dp, #E8EAEE, the keyboard's own
            // language in it. It sits outside the card, not in it.
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 6.dp, bottom = 34.dp)
                    .size(width = 72.dp, height = 58.dp)
                    .background(if (LocalBg.current == DarkBg) Color(0xFF2E2E2E) else Color(0xFFE8EAEE), RoundedCornerShape(18.dp))
                    .clickable { },
                contentAlignment = Alignment.Center,
            ) {
                Text("En", fontSize = 17.sp, color = if (LocalBg.current == DarkBg) DarkMuted else Color(0xFF61646A))
            }
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

@Composable
fun AppTopBar(filterActive: Boolean, privacyActive: Boolean, onDrawer: () -> Unit, onFilter: () -> Unit, onPrivacy: () -> Unit) {
    /*
     * Claude's narrow header is deliberately bare: a back arrow, no title, and
     * the ghost on the right. Sampled off its own portrait screenshot - the
     * phone layout carried a hamburger, the session name and a crossed-out eye,
     * none of which Claude shows at this width.
     */
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onDrawer) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current)
            }
            Spacer(Modifier.weight(1f))
            if (filterActive) {
                IconButton(onFilter) {
                    Icon(Icons.Outlined.Tune, contentDescription = "只看运行中", tint = Ember)
                }
            }
            IconButton(onPrivacy) { GhostGlyph(active = privacyActive, size = 22.dp) }
        }
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
        modifier = Modifier
            .size(64.dp)
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Timeline(items: List<Item>, modifier: Modifier, running: Boolean = false, onPerm: (String, String) -> Unit = { _, _ -> }, onPermReason: (String, String) -> Unit = { _, _ -> }, onAnswer: (String, List<String>) -> Unit = { _, _ -> }, onMessage: (Item.Msg) -> Unit = {}) {
    val listState = rememberLazyListState()
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
    LaunchedEffect(items.size, pending, running) {
        // Scroll to the last row that actually exists: the working line sits
        // after the items only while a turn is running, and asking for one row
        // past the end lands on nothing and animates back up.
        val last = items.size + if (running) 0 else -1
        if (last >= 0) listState.animateScrollToItem(last)
    }
    // A running turn gets one more row: Claude keeps a working line under the
    // last thing said, so the page does not look finished while it is not.
    LazyColumn(
        state = listState,
        modifier = modifier.padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        // The first turn used to sit flush against the header and read as
        // clipped; Claude leaves a breath of air above it.
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 10.dp, bottom = 6.dp),
    ) {
        for (item in items) {
            item(key = item.key) {
                // Every row fades and rises a little as it lands, which is what
                // makes a streamed reply read as arriving rather than repainting.
                var shown by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) { shown = true }
                val appear by animateFloatAsState(if (shown) 1f else 0f, tween(180), label = "row-in")
                Box(Modifier.graphicsLayer { alpha = appear; translationY = (1f - appear) * 8.dp.toPx() }) {
                when (item) {
                    is Item.Msg -> {
                        val isUser = item.role == "user"
                        Box(Modifier.fillMaxWidth()) {
                            Column(
                                Modifier
                                    .then(if (isUser) Modifier.align(Alignment.CenterEnd).fillMaxWidth(0.92f) else Modifier.fillMaxWidth())
                                    // Claude renders assistant turns straight on the
                                    // page - only user turns get a bubble.
                                    .background(
                                        if (isUser) LocalPill.current else Color.Transparent,
                                        RoundedCornerShape(12.dp),
                                    )
                                    // Claude's assistant prose breathes: 30 px between lines at 450 dpi,
                                    // and a user turn carries its own pill padding.
                                    .padding(horizontal = 10.dp, vertical = if (isUser) 10.dp else 5.dp)
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
                                // Claude sets a reply the way the desktop does:
                                // headings, real code boxes, lists. A user turn
                                // is their own words and is never parsed.
                                if (isUser) {
                                    if (item.text.isNotBlank()) Text(
                                        item.text.ifEmpty { "…" },
                                        fontSize = 15.sp,
                                        // Claude's prose is set with a little more
                                        // air than the default leading gives.
                                        lineHeight = 23.sp,
                                        color = LocalText.current,
                                    )
                                } else if (item.text.isNotBlank()) {
                                    MarkdownBody(
                                        item.text,
                                        dark = LocalBg.current == DarkBg,
                                    )
                                }
                            }
                        }
                    }
                    is Item.Tool -> {
                        var open by remember { mutableStateOf(false) }
                        // A call that is still going and one that broke read
                        // differently from one that finished quietly.
                        val failed = item.status == "error" || item.status == "failed"
                        val busy = item.status == "running" || item.status == "pending" || item.status == "in_progress"
                        val rowTint = when {
                            failed -> MaterialTheme.colorScheme.error
                            busy -> MaterialTheme.colorScheme.primary
                            else -> LocalMuted.current
                        }
                        Column(Modifier.padding(start = 10.dp)) {
                            Row(
                                Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 3.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                // One small glyph per tool family, muted like
                                // the verb - Claude's step rows lead with an
                                // icon and the phone had none.
                                Icon(
                                    when (item.name) {
                                        "read" -> Icons.AutoMirrored.Outlined.Article
                                        "edit", "write", "apply_patch", "patch" -> Icons.Outlined.Edit
                                        "bash", "exec_command", "execute" -> Icons.Outlined.Terminal
                                        "grep", "glob" -> Icons.Outlined.Search
                                        "list" -> Icons.Outlined.Folder
                                        "webfetch", "websearch" -> Icons.Outlined.Language
                                        else -> Icons.Outlined.Build
                                    },
                                    contentDescription = null,
                                    tint = rowTint,
                                    modifier = Modifier.size(15.dp),
                                )
                                Spacer(Modifier.width(7.dp))
                                Text(
                                    toolVerbOf(item.name, item.status) + if (item.title.isNotBlank()) " ${item.title}" else "",
                                    fontSize = 12.5.sp,
                                    color = if (failed || busy) rowTint else LocalMuted.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                if (item.output.isNotBlank()) {
                                    Icon(
                                        if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                                        contentDescription = if (open) "收起" else "展开",
                                        tint = LocalMuted.current,
                                        modifier = Modifier.size(16.dp),
                                    )
                                }
                            }
                            if (open && item.output.isNotBlank()) {
                                /*
                                 * A patch reads as one: added lines on a faint
                                 * green, removed on a faint red, hunk headers
                                 * muted. The desktop draws a full diff
                                 * component; a phone row only has space for
                                 * the colour, which is the part that makes a
                                 * patch scannable at all.
                                 */
                                val patch = item.output.contains("\n@@") || item.output.startsWith("diff --git") || item.output.startsWith("@@")
                                Column(Modifier.padding(start = 22.dp, top = 2.dp, bottom = 4.dp)) {
                                    for (line in item.output.lineSequence().take(60)) {
                                        val (bg, fg) = when {
                                            !patch -> Color.Transparent to LocalMuted.current.copy(alpha = 0.8f)
                                            line.startsWith("+") && !line.startsWith("+++") -> Color(0x1A2E7D32) to Color(0xFF2E7D32)
                                            line.startsWith("-") && !line.startsWith("---") -> Color(0x1AC62828) to Color(0xFFC62828)
                                            line.startsWith("@@") -> Color.Transparent to LocalMuted.current
                                            else -> Color.Transparent to LocalMuted.current.copy(alpha = 0.8f)
                                        }
                                        Text(
                                            line.ifEmpty { " " },
                                            fontSize = 11.sp,
                                            color = fg,
                                            modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 3.dp, vertical = 0.5.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                    is Item.Perm -> PermCard(item, onPerm = onPerm, onPermReason = onPermReason)
                    is Item.Quest -> QuestCard(item, onAnswer = onAnswer)
                    is Item.Err -> {
                        // A broken turn is a card, not a red line lost in the
                        // prose: the desktop gives it its own surface and its
                        // own weight, so a failure is as visible as a reply.
                        Row(
                            Modifier
                                .padding(start = 2.dp, top = 4.dp)
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Outlined.ErrorOutline,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.error,
                                modifier = Modifier.size(15.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(item.text, fontSize = 13.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                }
            }
        }
        if (running) {
            item(key = "working") { WorkingLine() }
        }
        // The scroll target (see the LaunchedEffect above).
        item(key = "__bottom") { Box(Modifier.height(0.dp)) }
    }
}

/**
 * Claude's working line: three dots that breathe while a turn is in flight.
 *
 * The desktop keeps a working mark under the last thing said so the page never
 * looks finished mid-turn; this is the same idea at phone size.
 */
@Composable
fun WorkingLine() {
    val transition = rememberInfiniteTransition(label = "working")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 3f,
        animationSpec = infiniteRepeatable(tween(1200, easing = LinearEasing), RepeatMode.Restart),
        label = "phase",
    )
    Row(Modifier.padding(start = 10.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until 3) {
            // Each dot is brightest when the phase passes it, which reads as a
            // wave rather than three blinking lights.
            val distance = kotlin.math.abs(((phase - i) % 3f + 3f) % 3f)
            val lift = (1f - (distance.coerceAtMost(1f))).coerceIn(0f, 1f)
            Box(
                Modifier
                    .padding(end = 5.dp)
                    .size(6.dp)
                    .graphicsLayer { alpha = 0.3f + 0.7f * lift; translationY = -2.dp.toPx() * lift }
                    .background(LocalMuted.current, CircleShape),
            )
        }
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

/**
 * The last fortnight as a bar per day, sized by tokens.
 *
 * The desktop's usage page leads with the same shape: a row of bars makes
 * "was I busy this week" a glance, where a list of numbers is a read. Days
 * with nothing spent stay as a hairline so the gaps are visible.
 */
@Composable
fun UsageChart(byDay: org.json.JSONArray) {
    val days = (0 until byDay.length()).mapNotNull { byDay.optJSONObject(it) }
    if (days.isEmpty()) return
    val peak = days.maxOf { day ->
        val u = day.optJSONObject("usage")
        (u?.optLong("input") ?: 0L) + (u?.optLong("output") ?: 0L)
    }.coerceAtLeast(1L)
    Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 2.dp)) {
        Row(
            Modifier.fillMaxWidth().height(56.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            for (day in days) {
                val u = day.optJSONObject("usage")
                val tokens = (u?.optLong("input") ?: 0L) + (u?.optLong("output") ?: 0L)
                val ratio = (tokens.toFloat() / peak).coerceIn(0.04f, 1f)
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight(ratio)
                        .background(
                            if (tokens > 0) MaterialTheme.colorScheme.primary.copy(alpha = 0.75f)
                            else LocalMuted.current.copy(alpha = 0.25f),
                            RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp),
                        ),
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(days.first().optString("key").takeLast(5), fontSize = 10.sp, color = LocalMuted.current)
            Text(days.last().optString("key").takeLast(5), fontSize = 10.sp, color = LocalMuted.current)
        }
    }
}

@Composable
fun UsageRow(key: String, bucket: JSONObject, bold: Boolean = false) {
    val usage = bucket.optJSONObject("usage") ?: JSONObject()
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(key, fontSize = 14.sp, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Medium, color = LocalText.current)
            Text(
                "${fmtTokens(usage.optLong("input"))} in · ${fmtTokens(usage.optLong("output"))} out · ${bucket.optInt("turns")} turns",
                fontSize = 11.sp, color = LocalMuted.current,
            )
        }
        Text(fmtCost(usage, bucket.optInt("priced"), bucket.optInt("unpriced")), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
    }
}

@Composable
fun UsageSheet(summary: JSONObject?) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
        Text("用量 · 近 30 天", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
        Spacer(Modifier.height(12.dp))
        if (summary == null) {
            Text("正在读取…", fontSize = 14.sp, color = LocalMuted.current, modifier = Modifier.padding(vertical = 16.dp))
            return@Column
        }
        val total = summary.optJSONObject("total") ?: JSONObject()
        Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        if (summary.optInt("priced") == 0 && summary.optInt("unpriced") > 0) "—"
                        else "$%.2f".format(total.optDouble("cost", 0.0)),
                        fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current,
                    )
                    Text("${summary.optInt("turns")} turns", fontSize = 11.sp, color = LocalMuted.current)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("${fmtTokens(total.optLong("input"))} in", fontSize = 12.sp, color = LocalMuted.current)
                    Text("${fmtTokens(total.optLong("output"))} out", fontSize = 12.sp, color = LocalMuted.current)
                    Text("${fmtTokens(total.optLong("reasoning"))} reasoning", fontSize = 12.sp, color = LocalMuted.current)
                }
            }
        }
        summary.optJSONArray("byDay")?.let { UsageChart(it) }
        Spacer(Modifier.height(14.dp))
        Text("按模型", fontSize = 13.sp, color = LocalMuted.current)
        summary.optJSONArray("byModel")?.let { arr ->
            for (i in 0 until arr.length()) {
                val b = arr.optJSONObject(i) ?: continue
                UsageRow(b.optString("key"), b)
            }
        }
        Spacer(Modifier.height(10.dp))
        Text("按天", fontSize = 13.sp, color = LocalMuted.current)
        summary.optJSONArray("byDay")?.let { arr ->
            for (i in 0 until arr.length()) {
                val b = arr.optJSONObject(i) ?: continue
                UsageRow(b.optString("key"), b)
            }
        }
    }
}

/* Claude's ask card: the question, its options and a typed answer. */
@Composable
fun QuestCard(item: Item.Quest, onAnswer: (String, List<String>) -> Unit) {
    val questions = item.request.optJSONArray("questions") ?: return
    val q = questions.optJSONObject(0) ?: return
    Column(Modifier.fillMaxWidth().background(LocalPill.current, RoundedCornerShape(12.dp)).padding(12.dp)) {
        Text(q.optString("header", "问题"), fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = LocalText.current)
        Spacer(Modifier.height(4.dp))
        Text(q.optString("question"), fontSize = 13.sp, color = LocalText.current)
        Spacer(Modifier.height(10.dp))
        val opts = q.optJSONArray("options")
        if (opts != null) for (i in 0 until opts.length()) {
            val o = opts.optJSONObject(i) ?: continue
            Surface(
                Modifier.fillMaxWidth().padding(bottom = 6.dp).clickable { onAnswer(item.requestId, listOf(o.optString("label"))) },
                shape = RoundedCornerShape(8.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                    Text(o.optString("label"), fontSize = 13.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                    if (o.optString("description").isNotBlank()) Text(o.optString("description"), fontSize = 11.sp, color = LocalMuted.current)
                }
            }
        }
        if (q.optBoolean("custom", true)) {
            var custom by remember { mutableStateOf("") }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    custom, { custom = it },
                    Modifier.weight(1f),
                    placeholder = { Text("自行输入…", fontSize = 12.sp, color = LocalMuted.current) },
                    singleLine = true,
                )
                TextButton({ if (custom.isNotBlank()) onAnswer(item.requestId, listOf(custom.trim())) }) { Text("发送") }
            }
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
    val chip = when {
        isBash && title.isNotBlank() && title != "Run command" -> title
        permVerbOf(kind) == "" && title.isNotBlank() -> title
        kind == "bash" || kind == "edit" || kind == "write" || kind == "outside" || kind == "webfetch" -> ""
        else -> title
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
        Modifier.fillMaxWidth().background(LocalSurface.current, RoundedCornerShape(20.dp)).padding(14.dp),
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
                Text("1/${item.queueTotal}", fontSize = 12.sp, color = LocalMuted.current)
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

/** A diff, coloured the way the desktop colours one: added green, removed red. */
@Composable
private fun DiffLines(diff: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().background(LocalPill.current.copy(alpha = 0.5f), RoundedCornerShape(8.dp)).padding(8.dp)) {
        for (line in diff.lineSequence().take(80)) {
            val (bg, fg) = when {
                line.startsWith("+") && !line.startsWith("+++") -> Color(0x1A2E7D32) to Color(0xFF2E7D32)
                line.startsWith("-") && !line.startsWith("---") -> Color(0x1AC62828) to Color(0xFFC62828)
                line.startsWith("@@") -> Color.Transparent to LocalMuted.current
                else -> Color.Transparent to LocalMuted.current.copy(alpha = 0.8f)
            }
            Text(
                line.ifEmpty { " " },
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                color = fg,
                modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 3.dp, vertical = 1.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionList(sessions: List<SessionRow>, current: String?, query: String, onSelect: (String) -> Unit, compact: Boolean, modifier: Modifier = Modifier, onLongPress: ((SessionRow) -> Unit)? = null) {
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
    LazyColumn(modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = if (compact) 6.dp else 6.dp)) {
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
                        .padding(horizontal = 14.dp, vertical = if (compact) 8.dp else 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (s.running || s.directory.isNotBlank()) {
                        // A running session wears the <> mark, and so does any
                        // session that belongs to a project folder - Claude
                        // draws the same split. A plain conversation keeps the
                        // speech bubble.
                        Icon(Icons.Outlined.Code, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(34.dp).padding(end = 14.dp, top = 1.dp))
                    } else {
                        Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(34.dp).padding(end = 14.dp, top = 1.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        // Claude sets the title and its timestamp tight against
                        // each other (32 px between the two baselines at 450
                        // dpi), so the pair reads as one row rather than two.
                        Text(
                            s.title.ifEmpty { s.id }.take(if (compact) 34 else 26),
                            fontSize = 15.sp,
                            lineHeight = 20.sp,
                            color = LocalText.current,
                            maxLines = 1,
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
                    if (s.running) Box(Modifier.size(7.dp).background(DotBlue, CircleShape))
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
    onProjects: () -> Unit,
    onScheduled: () -> Unit,
    onTasks: () -> Unit,
    onCode: () -> Unit,
    onUsage: () -> Unit = {},
    onSearch: () -> Unit = {},
    onSeeAll: () -> Unit = {},
    onLongPress: ((SessionRow) -> Unit)? = null,
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
            Spacer(Modifier.height(26.dp))
            DrawerItem(Icons.Outlined.Folder, "项目") { onProjects() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Code, "Code") { onCode() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Schedule, "定时任务") { onScheduled() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Checklist, "进行中的任务") { onTasks() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.BarChart, "用量") { onUsage() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Settings, "连接设置") { onReconnect() }
            Spacer(Modifier.height(20.dp))
            HorizontalDivider(color = LocalMuted.current.copy(alpha = 0.18f))
            Spacer(Modifier.height(18.dp))
            Text("最近使用", fontSize = 13.sp, color = LocalMuted.current)
            Spacer(Modifier.height(8.dp))
        }
        /*
         * Claude's drawer shows the three most recent conversations and then a
         * 「查看全部 ›」 row that opens the full list, so the drawer always fits
         * on one screen however long the history is.
         */
        Column(Modifier.weight(1f)) {
            SessionList(sessions.take(3), null, "", onSelect, compact = true, modifier = Modifier.fillMaxWidth(), onLongPress = onLongPress)
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
fun DrawerItem(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onClick() }.padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = label, tint = LocalText.current, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(18.dp))
        Text(label, fontSize = 16.sp, color = LocalText.current)
    }
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
        Spacer(Modifier.height(26.dp))
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

@Composable
fun InputCapsule(enabled: Boolean, modelLabel: String, onSend: (String, List<JSONObject>) -> Unit, onStop: () -> Unit, onNew: () -> Unit, modifier: Modifier = Modifier, onMic: () -> Unit = {}, onModel: () -> Unit = {}, running: Boolean = false, inject: String? = null, onInjected: () -> Unit = {}, pickImages: () -> Unit = {}, attachments: List<JSONObject> = emptyList(), onRemoveAttachment: (Int) -> Unit = {}, listening: Boolean = false, transcribing: Boolean = false) {
    var text by remember { mutableStateOf("") }
    LaunchedEffect(inject) { if (!inject.isNullOrEmpty()) { text = inject; onInjected() } }
    /*
     * Claude's composer card is inset from its pane on both sides - 59dp on the
     * pad, about a quarter of the pane - with 20dp corners and no drop shadow;
     * it sits on the page as a white plate, not as a floating sheet. This used
     * to run the full width of the pane at 28dp with an 8dp shadow.
     */
    Box(modifier.fillMaxWidth().padding(start = 118.dp, end = 113.dp, top = 8.dp, bottom = 8.dp)) {
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surface,
            // Claude's card carries a hairline: 220,220,220 on the pad, two
            // pixels wide at 400dpi, which is what separates a white plate from
            // a page that is almost as white.
            border = androidx.compose.foundation.BorderStroke(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFDCDCDC)),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                if (attachments.isNotEmpty()) {
                    // Claude shows pending shots as a thumbnail strip above
                    // the text field, each with an X to remove.
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        attachments.forEachIndexed { index, att ->
                            Box {
                                val bytes = android.util.Base64.decode(att.optString("data"), android.util.Base64.DEFAULT)
                                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                                Image(
                                    bitmap = bmp.asImageBitmap(),
                                    contentDescription = att.optString("path", "附件"),
                                    Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)),
                                    contentScale = ContentScale.Crop,
                                )
                                Box(
                                    Modifier.size(18.dp).align(Alignment.TopEnd).background(Color.Black.copy(alpha = 0.6f), CircleShape).clickable { onRemoveAttachment(index) },
                                    contentAlignment = Alignment.Center,
                                ) { Text("×", fontSize = 11.sp, color = Color.White) }
                            }
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                }
                OutlinedTextField(
                    text, { text = it },
                    Modifier.fillMaxWidth(),
                    placeholder = { Text("与 MCode 对话…", color = LocalMuted.current) },
                    colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent),
                    maxLines = 4,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    var plusMenu by remember { mutableStateOf(false) }
                    // Claude's + and mic both sit in a soft pill circle; the
                    // round button on the right is ink until there is something
                    // to send, then the theme's accent.
                    Box(
                        Modifier.size(36.dp).background(LocalPill.current, CircleShape).clickable(enabled = enabled) { plusMenu = true },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = "新对话或照片", tint = LocalText.current, modifier = Modifier.size(20.dp))
                        DropdownMenu(expanded = plusMenu, onDismissRequest = { plusMenu = false }) {
                            DropdownMenuItem(text = { Text("新对话") }, onClick = { plusMenu = false; onNew() })
                            DropdownMenuItem(text = { Text("照片") }, onClick = { plusMenu = false; pickImages() })
                        }
                    }
                    Spacer(Modifier.width(8.dp))
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
                    val sendBg = when {
                        hasWords && !dark -> Color(0xFFE1C0B3)
                        dark -> Color(0xFFF9F9F7)
                        else -> LocalText.current
                    }
                    val sendFg = when {
                        hasWords && !dark -> Color.White
                        dark -> Color(0xFF151515)
                        else -> LocalBg.current
                    }
                    Box(
                        Modifier.size(44.dp).background(sendBg, CircleShape).clickable(enabled = enabled && !transcribing) {
                            if (running) onStop()
                            else if (listening) onMic()
                            else if (text.isNotBlank() || attachments.isNotEmpty()) { onSend(text, attachments); text = "" }
                        },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (running) {
                            // A running turn turns the round button into stop,
                            // the way the desktop composer does.
                            Box(Modifier.size(16.dp).background(sendFg, RoundedCornerShape(3.dp)))
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
                            Icon(Icons.Filled.ArrowUpward, contentDescription = "发送", tint = sendFg, modifier = Modifier.size(22.dp))
                        }
                    }
                }
            }
        }
    }
}
