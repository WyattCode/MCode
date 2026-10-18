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
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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

private val Cream = Color(0xFFFAF9F5)
private val CreamSurface = Color(0xFFFFFFFF)
private val CreamPill = Color(0xFFF0EEE6)
private val CreamLine = Color(0xFFE4E1D8)
private val Ink = Color(0xFF1F1E1C)
private val InkMuted = Color(0xFF6B6862)
private val Ember = Color(0xFFD97757)
private val DotBlue = Color(0xFF3B82F6)

private val DarkBg = Color(0xFF26251F)
private val DarkSurface = Color(0xFF33322B)
private val DarkPill = Color(0xFF3B3A33)
private val DarkLine = Color(0xFF45443C)
private val DarkText = Color(0xFFF5F4EF)
private val DarkMuted = Color(0xFFA8A49B)

val LocalBg = staticCompositionLocalOf { Cream }
val LocalSurface = staticCompositionLocalOf { CreamSurface }
val LocalText = staticCompositionLocalOf { Ink }
val LocalMuted = staticCompositionLocalOf { InkMuted }
val LocalPill = staticCompositionLocalOf { CreamPill }
val LocalLine = staticCompositionLocalOf { CreamLine }

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

sealed class Item {
    abstract val key: String
    data class Msg(val id: String, val role: String, var text: String) : Item() { override val key = "msg.$id" }
    data class Tool(val uid: String, val name: String, val status: String, val output: String) : Item() { override val key = "tool.$uid" }
    data class Perm(val requestId: String, val kind: String, val detail: String) : Item() { override val key = "perm.$requestId" }
    data class Err(val text: String) : Item() { override val key = "err.$text.${hashCode()}" }
}

data class SessionRow(val id: String, val title: String, val running: Boolean, val updated: Long, val directory: String = "", val model: String = "")

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
        // Recomputed on fold/unfold instead of recreating the activity, so the
        // WebSocket and the open conversation survive the transition.
        widthSize.value = computeWidthClass()
        setContent {
            MCodeTheme {
                App(widthSize.value, autoUrl, autoToken) { u, t ->
                    prefs.edit().putString("url", u).putString("token", t).apply()
                }
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        widthSize.value = computeWidthClass()
    }

    /** Material 3's breakpoints, straight off the current window configuration. */
    private fun computeWidthClass(): WindowWidthSizeClass {
        val w = resources.configuration.screenWidthDp
        return when {
            w >= 840 -> WindowWidthSizeClass.Expanded
            w >= 600 -> WindowWidthSizeClass.Medium
            else -> WindowWidthSizeClass.Compact
        }
    }
}

@Composable
fun MCodeTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
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
    ) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/* MCode's own mark, straight from the desktop build. */
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
fun App(widthSize: WindowWidthSizeClass, autoUrl: String, autoToken: String, onSave: (String, String) -> Unit) {
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
    var voiceText by remember { mutableStateOf<String?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current

    val voiceLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!heard.isNullOrBlank()) voiceText = heard
    }
    fun startVoice() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "对 MCode 说话")
        }
        runCatching { voiceLauncher.launch(intent) }
            .onFailure { Toast.makeText(context, "没有可用的语音识别服务", Toast.LENGTH_SHORT).show() }
    }

    val sessions = remember { mutableStateListOf<SessionRow>() }
    val items = remember { mutableStateListOf<Item>() }
    val messageIndex = remember { mutableStateMapOf<String, Int>() }
    var currentSession by remember { mutableStateOf<String?>(null) }
    var cursor by remember { mutableStateOf(0L) }

    fun frame(json: JSONObject) = client.send(json.toString())

    fun request(request: JSONObject, id: String) {
        frame(JSONObject().put("kind", "request").put("id", id).put("request", request))
    }
    fun request(request: JSONObject): String {
        val id = "r" + System.nanoTime()
        request(request, id)
        return id
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
        if (known != null && known in items.indices) {
            val existing = items[known]
            if (existing is Item.Msg) items[known] = existing.copy(text = text.toString().trim())
        } else {
            items.add(Item.Msg(id, role, text.toString().trim().ifEmpty { "…" }))
            messageIndex[id] = items.size - 1
        }
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val part = parts.optJSONObject(i) ?: continue
                if (part.optString("type") == "tool") {
                    items.add(Item.Tool(java.util.UUID.randomUUID().toString(), part.optString("name", "tool"), part.optString("status", ""), part.optString("output", "").replace(Regex("<[^>]+>"), "").lineSequence().firstOrNull()?.take(90) ?: ""))
                }
            }
        }
    }

    fun upsertPart(sessionID: String, messageID: String, part: JSONObject) {
        if (sessionID != currentSession) return
        val known = messageIndex[messageID] ?: return
        val existing = items[known]
        if (existing !is Item.Msg) return
        when (part.optString("type")) {
            "text" -> items[known] = existing.copy(text = part.optString("text"))
            "tool" -> items.add(Item.Tool(java.util.UUID.randomUUID().toString(), part.optString("name", "tool"), part.optJSONObject("state")?.optString("status", "") ?: "", part.optString("output", "").replace(Regex("<[^>]+>"), "").lineSequence().firstOrNull()?.take(90) ?: ""))
        }
    }

    fun select(id: String?) {
        currentSession = id
        items.clear()
        messageIndex.clear()
        if (id == null) return
        frame(JSONObject().put("kind", "request").put("id", "w${System.nanoTime()}")
            .put("request", JSONObject().put("type", "session.watch").put("sessionIDs", org.json.JSONArray().put(id))))
        // History first; the live stream rides on top of it.
        scope.launch {
            val ticket = "h${System.nanoTime()}"
            val deferred = client.awaitResponse(ticket)
            request(JSONObject().put("type", "session.get").put("sessionID", id), ticket)
            val res = runCatching { deferred.await() }.getOrNull() ?: return@launch
            val messages = res.optJSONObject("data")?.optJSONArray("messages") ?: return@launch
            for (i in 0 until messages.length()) upsertMessage(id, messages.optJSONObject(i) ?: continue)
        }
    }

    fun handle(f: JSONObject) {
        when (f.optString("kind")) {
            "remote.welcome" -> {
                cursor = f.optLong("eventId", 0)
                frame(JSONObject().put("kind", "remote.resume").put("cursor", cursor))
                request(JSONObject().put("type", "session.list"), "list${System.nanoTime()}")
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
                        sessions.add(SessionRow(sid, s.optString("title", sid), sid in running, s.optLong("updated", 0), s.optString("directory", ""), s.optJSONObject("model")?.optString("model", "") ?: ""))
                    }
                    sessions.sortByDescending { it.updated }
                    if (currentSession == null && sessions.isNotEmpty()) select(sessions.first().id)
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
                        if (row != null) sessions[sessions.indexOf(row)] = row.copy(title = title, updated = updated, directory = directory, model = model)
                        else sessions.add(SessionRow(sid, title, false, updated, directory, model))
                        sessions.sortByDescending { it.updated }
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
                    "message.part.updated" -> upsertPart(event.optString("sessionID"), event.optString("messageID"), event.optJSONObject("part") ?: return)
                    "permission.requested" -> {
                        val r = event.optJSONObject("request") ?: return
                        items.add(Item.Perm(r.optString("id"), r.optString("kind", "tool"), r.optString("title", "") + " " + r.optJSONObject("meta")?.optString("path", "")))
                    }
                    "permission.resolved" -> items.removeAll { it is Item.Perm && it.requestId == event.optString("requestID") }
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
        ConnectScreen(url, token, onDismiss = { showConnect = false }) { u, t ->
            showConnect = false
            url = u; token = t
            onSave(u, t)
            client.close()
            client.connect(u, t)
        }
        return
    }

    val wide = widthSize >= WindowWidthSizeClass.Medium
    val empty = items.isEmpty()

    // 项目/运行中过滤后的列表；模型 pill 显示当前会话的真实模型。
    val visibleSessions = sessions.filter { (projectFilter == null || it.directory == projectFilter) && (!runningOnly || it.running) }
    val currentModel = sessions.find { it.id == currentSession }?.model?.takeIf { it.isNotBlank() } ?: "本地模型"

    val inputBar: @Composable () -> Unit = {
        InputCapsule(
            enabled = currentSession != null,
            modelLabel = currentModel,
            onMic = { startVoice() },
            inject = voiceText,
            onInjected = { voiceText = null },
            onSend = { text ->
                // steer only joins a running turn; an idle session gets a
                // plain prompt or the server ignores the message outright.
                val req = JSONObject().put("type", "session.prompt").put("sessionID", currentSession!!).put("text", text)
                if (sessions.find { it.id == currentSession }?.running == true) req.put("delivery", "steer")
                request(req)
            },
            onStop = { currentSession?.let { request(JSONObject().put("type", "session.abort").put("sessionID", it)) } },
            onNew = { request(JSONObject().put("type", "session.create").put("title", "来自手机")) },
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
                        request(JSONObject().put("type", "session.create").put("title", "来自手机"))
                        closeDrawer()
                    },
                    onReconnect = { showConnect = true; closeDrawer() },
                    onProjects = { showProjects = true; closeDrawer() },
                    onScheduled = { showScheduled = true; closeDrawer() },
                    onCode = { closeDrawer() },
                    onLongPress = { sheetTarget = it },
                )
            }
        },
    ) {
        if (wide) {
            // Claude's fold layout: the top bar spans, records fill the left
            // column to the bottom, and the conversation (with its input when
            // there is one) lives in the right column.
            Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                AppTopBar(wide = true, title = "最近记录", filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onTasks = { showTasks = true }, onPrivacy = { privacy = !privacy })
                Row(Modifier.weight(1f).fillMaxWidth()) {
                    Column(Modifier.weight(0.42f).fillMaxHeight()) {
                        OutlinedTextField(
                            search, { search = it },
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                            placeholder = { Text("搜索", color = LocalMuted.current) },
                            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = LocalMuted.current) },
                            shape = RoundedCornerShape(14.dp),
                            colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant, focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant, unfocusedBorderColor = Color.Transparent, focusedBorderColor = Color.Transparent),
                            singleLine = true,
                        )
                        Spacer(Modifier.height(6.dp))
                        SessionList(visibleSessions, currentSession, search, onSelect = { select(it) }, compact = false, modifier = Modifier.weight(1f), onLongPress = { sheetTarget = it })
                    }
                    Box(Modifier.weight(0.58f).fillMaxHeight()) {
                        if (empty) {
                            WelcomePane(withInput = true, inputBar = inputBar)
                        } else {
                            Column(Modifier.fillMaxSize()) {
                                Box(Modifier.weight(1f)) { Timeline(items, Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp)) }
                                inputBar()
                            }
                        }
                    }
                }
                Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
            }
        } else {
            if (empty) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    AppTopBar(wide = false, title = "MCode", filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onTasks = { showTasks = true }, onPrivacy = { privacy = !privacy })
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        WelcomePane(withInput = true, inputBar = inputBar)
                    }
                    Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
                }
            } else {
                Scaffold(
                    containerColor = MaterialTheme.colorScheme.background,
                    topBar = { AppTopBar(wide = false, title = currentSessionTitle(sessions, currentSession), filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onTasks = { showTasks = true }, onPrivacy = { privacy = !privacy }) },
                    bottomBar = {
                        Column {
                            inputBar()
                            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
                        }
                    },
                ) { padding ->
                    Box(Modifier.padding(padding).fillMaxSize()) { Timeline(items, Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp)) }
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
                Row(Modifier.fillMaxWidth().clickable { request(JSONObject().put("type", "session.delete").put("sessionID", row.id)); sheetTarget = null }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.DeleteOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("删除", fontSize = 15.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        }
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
}

/* The welcome pane: mark, greeting, and (for a fresh screen) the input. */
@Composable
fun WelcomePane(withInput: Boolean, inputBar: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        MCodeMark(Modifier.size(96.dp))
        Spacer(Modifier.height(16.dp))
        Text("欢迎，${MainActivity.OPERATOR}", fontFamily = FontFamily.Serif, fontSize = 27.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
        Spacer(Modifier.height(22.dp))
        if (withInput) inputBar()
    }
}

@Composable
fun AppTopBar(wide: Boolean, title: String, filterActive: Boolean, privacyActive: Boolean, onDrawer: () -> Unit, onFilter: () -> Unit, onTasks: () -> Unit, onPrivacy: () -> Unit) {
    // Same color as the page, and it owns the status-bar inset so the cream
    // runs under the system bar instead of a black strip.
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onDrawer) {
                Icon(Icons.Outlined.Menu, contentDescription = "菜单", tint = LocalText.current)
            }
            Spacer(Modifier.weight(1f))
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
            Spacer(Modifier.weight(1f))
            IconButton(onFilter) {
                Icon(Icons.Outlined.Tune, contentDescription = "只看运行中", tint = if (filterActive) Ember else LocalText.current)
            }
            IconButton(onTasks) {
                Icon(Icons.Outlined.Checklist, contentDescription = "进行中的任务", tint = LocalText.current)
            }
            IconButton(onPrivacy) {
                Icon(
                    if (privacyActive) Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff,
                    contentDescription = "隐私模糊",
                    tint = if (privacyActive) Ember else LocalMuted.current,
                )
            }
        }
    }
}

fun currentSessionTitle(sessions: List<SessionRow>, current: String?): String =
    current?.let { id -> sessions.find { it.id == id }?.title } ?: "MCode"

/* ------------------------------------------------------------------ */
/* Timeline / lists                                                    */
/* ------------------------------------------------------------------ */

@Composable
fun Timeline(items: List<Item>, modifier: Modifier) {
    LazyColumn(modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (item in items) {
            item(key = item.key) {
                when (item) {
                    is Item.Msg -> {
                        val isUser = item.role == "user"
                        Box(Modifier.fillMaxWidth()) {
                            Column(
                                Modifier
                                    .then(if (isUser) Modifier.align(Alignment.CenterEnd).fillMaxWidth(0.85f) else Modifier.fillMaxWidth())
                                    .background(
                                        if (isUser) LocalPill.current else MaterialTheme.colorScheme.surfaceVariant,
                                        RoundedCornerShape(12.dp),
                                    )
                                    .padding(10.dp),
                            ) {
                                Text(if (isUser) "你" else "MCode", fontSize = 11.sp, color = LocalMuted.current)
                                Text(item.text.ifEmpty { "…" }, fontSize = 14.sp, color = LocalText.current)
                            }
                        }
                    }
                    is Item.Tool -> {
                        var open by remember { mutableStateOf(false) }
                        Column(
                            Modifier.padding(start = 10.dp).clickable { open = !open },
                        ) {
                            Text("· ${item.name} ${item.status}" + if (item.output.isNotBlank() && !open) " ▸" else "", fontSize = 12.sp, color = LocalMuted.current)
                            if (item.output.isNotBlank()) {
                                Text(
                                    item.output,
                                    fontSize = 11.sp,
                                    color = LocalMuted.current.copy(alpha = 0.8f),
                                    maxLines = if (open) Int.MAX_VALUE else 1,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                    is Item.Perm -> PermCard(item, onPerm = { _, _ -> })
                    is Item.Err -> Text(item.text, fontSize = 12.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(start = 10.dp))
                }
            }
        }
    }
}

@Composable
fun PermCard(item: Item.Perm, onPerm: (String, String) -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(LocalPill.current, RoundedCornerShape(12.dp)).padding(10.dp),
    ) {
        Text("权限请求：${item.kind}", fontWeight = FontWeight.Medium, fontSize = 14.sp, color = LocalText.current)
        if (item.detail.isNotBlank()) Text(item.detail, fontSize = 12.sp, color = LocalMuted.current)
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button({ onPerm(item.requestId, "once") }, Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = LocalText.current)) { Text("允许一次", color = LocalBg.current) }
            Button({ onPerm(item.requestId, "always") }, Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = LocalPill.current)) { Text("总是", color = LocalText.current) }
            Button({ onPerm(item.requestId, "reject") }, Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("拒绝", color = Color.White) }
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
    LazyColumn(modifier.fillMaxSize()) {
        for (s in filtered) {
            item(key = s.id) {
                Row(
                    Modifier.fillMaxWidth().combinedClickable(onClick = { onSelect(s.id) }, onLongClick = { onLongPress?.invoke(s) }).padding(horizontal = 14.dp, vertical = if (compact) 8.dp else 11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("</>", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.width(34.dp))
                    Column(Modifier.weight(1f)) {
                        Text(s.title.ifEmpty { s.id }.take(if (compact) 34 else 26), fontSize = 15.sp, color = LocalText.current, maxLines = 1)
                        if (!compact) Text(relTime(s.updated), fontSize = 12.sp, color = LocalMuted.current)
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
    onCode: () -> Unit,
    onLongPress: ((SessionRow) -> Unit)? = null,
) {
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(28.dp))
            Text("MCode", fontFamily = FontFamily.Serif, fontSize = 27.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
            Spacer(Modifier.height(26.dp))
            DrawerItem(Icons.Outlined.Folder, "项目") { onProjects() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Code, "Code") { onCode() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Schedule, "定时任务") { onScheduled() }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Settings, "连接设置") { onReconnect() }
            Spacer(Modifier.height(20.dp))
            HorizontalDivider(color = LocalMuted.current.copy(alpha = 0.18f))
            Spacer(Modifier.height(18.dp))
            Text("最近使用", fontSize = 13.sp, color = LocalMuted.current)
            Spacer(Modifier.height(8.dp))
        }
        SessionList(sessions, null, "", onSelect, compact = true, modifier = Modifier.weight(1f), onLongPress = onLongPress)
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
fun ConnectScreen(url: String, token: String, onDismiss: () -> Unit, onConnect: (String, String) -> Unit) {
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
fun InputCapsule(enabled: Boolean, modelLabel: String, onSend: (String) -> Unit, onStop: () -> Unit, onNew: () -> Unit, modifier: Modifier = Modifier, onMic: () -> Unit = {}, inject: String? = null, onInjected: () -> Unit = {}) {
    var text by remember { mutableStateOf("") }
    LaunchedEffect(inject) { if (!inject.isNullOrEmpty()) { text = inject; onInjected() } }
    Box(modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp)) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 8.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                OutlinedTextField(
                    text, { text = it },
                    Modifier.fillMaxWidth(),
                    placeholder = { Text("与 MCode 对话…", color = LocalMuted.current) },
                    colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent),
                    maxLines = 4,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(38.dp).background(LocalPill.current, CircleShape).clickable(enabled = enabled) { onNew() },
                        contentAlignment = Alignment.Center,
                    ) { Text("+", fontSize = 19.sp, color = LocalText.current) }
                    Spacer(Modifier.width(8.dp))
                    Surface(shape = RoundedCornerShape(17.dp), color = LocalPill.current) {
                        Text(modelLabel, fontSize = 13.sp, color = LocalText.current, modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    Box(
                        Modifier.size(38.dp).background(LocalPill.current, CircleShape).clickable { onMic() },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Outlined.Mic, contentDescription = "语音输入", tint = LocalText.current, modifier = Modifier.size(19.dp)) }
                    Spacer(Modifier.width(8.dp))
                    Box(
                        Modifier.size(44.dp).background(LocalText.current, CircleShape).clickable(enabled = enabled) {
                            if (text.isNotBlank()) { onSend(text); text = "" }
                        },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (text.isBlank()) {
                            Icon(Icons.Outlined.GraphicEq, contentDescription = "语音输入", tint = LocalBg.current, modifier = Modifier.size(20.dp))
                        } else {
                            Icon(Icons.Outlined.Checklist, contentDescription = "发送", tint = LocalBg.current, modifier = Modifier.size(19.dp))
                        }
                    }
                }
            }
        }
    }
}
