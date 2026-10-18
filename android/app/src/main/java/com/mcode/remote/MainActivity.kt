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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChatBubbleOutline
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
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

private val Cream = Color(0xFFF9F9F7)
private val CreamSurface = Color(0xFFFEFEFE)
private val CreamPill = Color(0xFFF0EFEC)
private val CreamLine = Color(0xFFE4E1D8)
private val Ink = Color(0xFF1F1E1C)
private val InkMuted = Color(0xFF6B6862)
private val Ember = Color(0xFFD97757)
private val DotBlue = Color(0xFF3B82F6)

private val DarkBg = Color(0xFF151515)
private val DarkSurface = Color(0xFF18191B)
private val DarkPill = Color(0xFF38393B)
private val DarkLine = Color(0xFF232323)
private val DarkText = Color(0xFFF5F4EF)
private val DarkMuted = Color(0xFF888681)

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
    data class Quest(val requestId: String, val request: JSONObject) : Item() { override val key = "quest.$requestId" }
    data class Err(val text: String) : Item() { override val key = "err.$text.${hashCode()}" }
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
    var deleteTarget by remember { mutableStateOf<SessionRow?>(null) }
    var voiceText by remember { mutableStateOf<String?>(null) }
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
        val recorder = android.media.MediaRecorder()
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
                val card = Item.Perm(p.optString("id"), p.optString("kind", "tool"), p.optString("title", "") + " " + p.optString("subject", ""))
                if (card.key !in known) items.add(card)
            }
        }
    }

    fun upsertMessage(sessionID: String, message: JSONObject) {        if (sessionID != currentSession) return
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
            val body = text.toString().trim()
            if (body.isNotEmpty() || role == "user") {
                items.add(Item.Msg(id, role, body.ifEmpty { "…" }))
                messageIndex[id] = items.size - 1
            }
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
        // Parked permissions ride along: a turn can be sitting on an answer
        // while the phone reconnected, and the card must not vanish with the
        // in-memory timeline (the desktop replays these the same way).
        for (p in pendingPerms[id].orEmpty()) items.add(Item.Perm(p.optString("id"), p.optString("kind", "tool"), p.optString("title", "") + " " + p.optString("subject", "")))
        for (r in pendingQuestions[id].orEmpty()) items.add(Item.Quest(r.optString("id"), r))
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
                loadPendingQuestions()
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
                    if (currentSession == null && sessions.isNotEmpty()) select(sessions.first().id)
                    else currentSession?.let { sid ->
                        val known = items.map { it.key }.toSet()
                        for (p in pendingPerms[sid].orEmpty()) {
                            val card = Item.Perm(p.optString("id"), p.optString("kind", "tool"), p.optString("title", "") + " " + p.optString("subject", ""))
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
                        pendingPerms.getOrPut(r.optString("sessionID")) { mutableListOf() }.add(r)
                        items.add(Item.Perm(r.optString("id"), r.optString("kind", "tool"), r.optString("title", "") + " " + r.optString("subject", "")))
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
        ConnectScreen(url, token, onDismiss = { showConnect = false }) { u, t ->
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
    val currentModelLabel = if (effortLabel.isNotEmpty()) "$currentModel $effortLabel" else currentModel

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
                val req = JSONObject().put("type", "session.prompt").put("sessionID", currentSession!!).put("text", text)
                if (atts.isNotEmpty()) req.put("attachments", org.json.JSONArray(atts.toList()))
                if (sessions.find { it.id == currentSession }?.running == true) req.put("delivery", "steer")
                request(req)
                attachments.clear()
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
                    onTasks = { showTasks = true; closeDrawer() },
                    onUsage = { loadUsage(); showUsage = true; closeDrawer() },
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
                Column(Modifier.weight(0.42f).fillMaxHeight()) {
                    Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconButton({ openDrawer() }) { Icon(Icons.Outlined.Menu, contentDescription = "菜单", tint = LocalText.current) }
                        // Claude centres the title in the column and keeps the
                        // two glyphs (tune, list) at its right.
                        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                            Text("最近记录", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                        }
                        IconButton({ runningOnly = !runningOnly }) { Icon(Icons.Outlined.Tune, contentDescription = "筛选", tint = LocalText.current) }
                        IconButton({ showTasks = true }) { Icon(Icons.Outlined.Checklist, contentDescription = "任务", tint = LocalText.current) }
                    }
                    OutlinedTextField(
                        search, { search = it },
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        placeholder = { Text("搜索", color = LocalMuted.current) },
                        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = LocalMuted.current) },
                        shape = RoundedCornerShape(14.dp),
                        // Claude's search sits on white with a hairline pill
                        // outline, not on the page's own colour with none.
                        colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surface, focusedContainerColor = MaterialTheme.colorScheme.surface, unfocusedBorderColor = LocalPill.current, focusedBorderColor = LocalPill.current),
                        singleLine = true,
                    )
                        Spacer(Modifier.height(6.dp))
                        SessionList(visibleSessions, currentSession, search, onSelect = { select(it) }, compact = false, modifier = Modifier.weight(1f), onLongPress = { sheetTarget = it })
                        // Claude parks a black "new chat" pill at the foot of
                        // the list column in the wide layout.
                        Spacer(Modifier.height(8.dp))
                        Surface(
                            shape = RoundedCornerShape(24.dp),
                            color = LocalText.current,
                            modifier = Modifier.align(Alignment.CenterHorizontally).clickable {
                                request(JSONObject().put("type", "session.create").put("title", "来自手机"))
                            },
                        ) {
                            Row(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("+", fontSize = 16.sp, color = LocalBg.current)
                                Spacer(Modifier.width(6.dp))
                                Text("新建会话", fontSize = 14.sp, color = LocalBg.current)
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                    }
                    Box(Modifier.width(1.dp).fillMaxHeight().background(LocalMuted.current.copy(alpha = 0.25f)))
                    Column(Modifier.weight(0.58f).fillMaxHeight()) {
                        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(currentSessionTitle(sessions, currentSession), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            IconButton({ privacy = !privacy }) { GhostGlyph(active = privacy, size = 22.dp) }
                        }
                        // The conversation pane, and only it, rides above the IME.
                        Column(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.ime.only(WindowInsetsSides.Bottom))) {
                            if (empty) {
                                WelcomePane(withInput = true, inputBar = inputBar, inputAtBottom = true)
                            } else {
                                Column(Modifier.fillMaxSize()) {
                                    Box(Modifier.weight(1f)) { Timeline(items, Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp), running = sessions.find { it.id == currentSession }?.running == true, onPerm = ::respondPerm, onAnswer = ::answerQuestion) }
                                    inputBar()
                                }
                            }
                        }
                    }
                }
        } else {
            if (empty) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    AppTopBar(wide = false, title = "", filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onTasks = { showTasks = true }, onPrivacy = { privacy = !privacy })
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        WelcomePane(withInput = true, inputBar = inputBar)
                    }
                    Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)))
                }
            } else {
                Scaffold(
                    containerColor = MaterialTheme.colorScheme.background,
                    topBar = { AppTopBar(wide = false, title = currentSessionTitle(sessions, currentSession), filterActive = runningOnly, privacyActive = privacy, onDrawer = { openDrawer() }, onFilter = { runningOnly = !runningOnly }, onTasks = { showTasks = true }, onPrivacy = { privacy = !privacy }) },
                    bottomBar = {
                        Column {
                            inputBar()
                            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)))
                        }
                    },
                ) { padding ->
                    Box(Modifier.padding(padding).fillMaxSize()) { Timeline(items, Modifier.fillMaxSize().blur(if (privacy) 14.dp else 0.dp), running = sessions.find { it.id == currentSession }?.running == true, onPerm = ::respondPerm, onAnswer = ::answerQuestion) }
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
                Row(Modifier.fillMaxWidth().clickable { deleteTarget = row; sheetTarget = null }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.DeleteOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text("删除…", fontSize = 15.sp, color = MaterialTheme.colorScheme.error)
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
                val currentRow = sessions.find { it.id == currentSession }
                // ---- Agent: build / plan ----
                Text("Agent", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(top = 8.dp, bottom = 2.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (agent in listOf("build", "plan")) {
                        val active = currentRow?.agent == agent
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
                        val active = currentRow?.effort == effort
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
                                        } catch (e: Exception) {
                                            println("[remote] session.model failed: $e")
                                        }
                                    }
                                }
                                modelPicker = false
                            }.padding(vertical = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(label, fontSize = 15.sp, color = if (label == currentModel) MaterialTheme.colorScheme.primary else LocalText.current)
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
    val mark = @Composable {
        MCodeMark(Modifier.size(96.dp))
        Spacer(Modifier.height(16.dp))
        Text(greeting(), fontSize = 27.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
    }
    if (inputAtBottom) {
        // Claude's wide empty state: the greeting floats mid-pane while the
        // input capsule sits on the bottom edge.
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) { mark() }
            if (withInput) Box(Modifier.align(Alignment.BottomCenter)) { inputBar() }
        }
    } else {
        Column(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            mark()
            Spacer(Modifier.height(22.dp))
            if (withInput) inputBar()
        }
    }
}

@Composable
fun AppTopBar(wide: Boolean, title: String, filterActive: Boolean, privacyActive: Boolean, onDrawer: () -> Unit, onFilter: () -> Unit, onTasks: () -> Unit, onPrivacy: () -> Unit) {
    // Claude's portrait header carries only the ghost; tune and the task
    // list appear with the two-pane layout.
    val showTools = wide
    // Same color as the page, and it owns the status-bar inset so the cream
    // runs under the system bar instead of a black strip.
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(0.42f), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onDrawer) {
                    Icon(Icons.Outlined.Menu, contentDescription = "菜单", tint = LocalText.current)
                }
                Spacer(Modifier.weight(1f))
                Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                if (showTools) {
                    IconButton(onFilter) {
                        Icon(Icons.Outlined.Tune, contentDescription = "只看运行中", tint = if (filterActive) Ember else LocalText.current)
                    }
                    IconButton(onTasks) {
                        Icon(Icons.Outlined.Checklist, contentDescription = "进行中的任务", tint = LocalText.current)
                    }
                }
            }
            Spacer(Modifier.weight(0.58f))
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

fun greeting(): String = "${MainActivity.OPERATOR} 回来了！"

fun currentSessionTitle(sessions: List<SessionRow>, current: String?): String =
    current?.let { id -> sessions.find { it.id == id }?.title } ?: "MCode"

/* ------------------------------------------------------------------ */
/* Timeline / lists                                                    */
/* ------------------------------------------------------------------ */

@Composable
fun Timeline(items: List<Item>, modifier: Modifier, running: Boolean = false, onPerm: (String, String) -> Unit = { _, _ -> }, onAnswer: (String, List<String>) -> Unit = { _, _ -> }) {
    val listState = rememberLazyListState()
    // Follow new items: when a message is sent or a reply/tool event lands,
    // keep the latest content in view the way Claude does.
    LaunchedEffect(items.size) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.size - 1)
    }
    // A running turn gets one more row: Claude keeps a working line under the
    // last thing said, so the page does not look finished while it is not.
    LazyColumn(state = listState, modifier = modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                                    .then(if (isUser) Modifier.align(Alignment.CenterEnd).fillMaxWidth(0.85f) else Modifier.fillMaxWidth())
                                    // Claude renders assistant turns straight on the
                                    // page - only user turns get a bubble.
                                    .background(
                                        if (isUser) LocalPill.current else Color.Transparent,
                                        RoundedCornerShape(12.dp),
                                    )
                                    .padding(horizontal = 10.dp, vertical = if (isUser) 10.dp else 2.dp),
                            ) {
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
                    is Item.Perm -> PermCard(item, onPerm = onPerm)
                    is Item.Quest -> QuestCard(item, onAnswer = onAnswer)
                    is Item.Err -> Text(item.text, fontSize = 12.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(start = 10.dp))
                }
                }
            }
        }
        if (running) {
            item(key = "working") { WorkingLine() }
        }
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
    onTasks: () -> Unit,
    onCode: () -> Unit,
    onUsage: () -> Unit = {},
    onLongPress: ((SessionRow) -> Unit)? = null,
) {
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(28.dp))
            Text("MCode", fontSize = 27.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
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
fun InputCapsule(enabled: Boolean, modelLabel: String, onSend: (String, List<JSONObject>) -> Unit, onStop: () -> Unit, onNew: () -> Unit, modifier: Modifier = Modifier, onMic: () -> Unit = {}, onModel: () -> Unit = {}, running: Boolean = false, inject: String? = null, onInjected: () -> Unit = {}, pickImages: () -> Unit = {}, attachments: List<JSONObject> = emptyList(), onRemoveAttachment: (Int) -> Unit = {}, listening: Boolean = false, transcribing: Boolean = false) {
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
                    val sendBg = when {
                        hasWords && !isSystemInDarkTheme() -> Color(0xFFE1C0B3)
                        else -> LocalText.current
                    }
                    val sendFg = when {
                        hasWords && !isSystemInDarkTheme() -> Color.White
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
