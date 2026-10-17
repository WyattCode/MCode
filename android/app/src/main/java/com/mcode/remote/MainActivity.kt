package com.mcode.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

sealed class Item {
    abstract val key: String
    data class Msg(val id: String, val role: String, var text: String) : Item() { override val key = "msg.$id" }
    data class Tool(val name: String, val status: String) : Item() { override val key = "tool.$name.$status.${hashCode()}" }
    data class Perm(val requestId: String, val kind: String, val detail: String) : Item() { override val key = "perm.$requestId" }
    data class Err(val text: String) : Item() { override val key = "err.$text.${hashCode()}" }
}

data class SessionRow(val id: String, val title: String, val running: Boolean, val updated: Long)

class RemoteClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var ws: okhttp3.WebSocket? = null

    var onFrame: (JSONObject) -> Unit = {}
    var onState: (Boolean) -> Unit = {}

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
                    println("[remote] frame kind: " + frame.optString("kind"))
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
        /** Single-operator defaults; overridden by what the connect screen saves. */
        const val DEFAULT_URL = "ws://192.168.10.156:7900"
        const val DEFAULT_TOKEN = "mcode-fold-2026"
        const val PREFS = "mcode-remote"
    }

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val savedUrl = prefs.getString("url", DEFAULT_URL) ?: DEFAULT_URL
        val savedToken = prefs.getString("token", DEFAULT_TOKEN) ?: DEFAULT_TOKEN
        val autoUrl = intent.getStringExtra("connectUrl") ?: savedUrl
        val autoToken = intent.getStringExtra("connectToken") ?: savedToken
        setContent {
            val wsc = calculateWindowSizeClass(this)
            MCodeTheme {
                App(wsc.widthSizeClass, autoUrl, autoToken) { u, t ->
                    prefs.edit().putString("url", u).putString("token", t).apply()
                }
            }
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
    ) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/* The Claude starburst is replaced by MCode's own mark (PC artwork). */
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

@Composable
fun App(widthSize: WindowWidthSizeClass, autoUrl: String, autoToken: String, onSave: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val client = remember { RemoteClient() }

    var connected by remember { mutableStateOf(false) }
    var connectedOnce by remember { mutableStateOf(autoUrl.isNotBlank() && autoToken.isNotBlank()) }
    var url by remember { mutableStateOf(autoUrl) }
    var token by remember { mutableStateOf(autoToken) }
    var showConnect by remember { mutableStateOf(false) }
    var drawerOpen by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }

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
        val parts = message.optJSONArray("parts") ?: return
        val text = StringBuilder()
        for (i in 0 until parts.length()) {
            val part = parts.optJSONObject(i) ?: continue
            if (part.optString("type") == "text") text.append(part.optString("text")).append("\n")
        }
        val known = messageIndex[id]
        if (known != null && known in items.indices) {
            val existing = items[known]
            if (existing is Item.Msg) items[known] = existing.copy(text = text.toString().trim())
        } else {
            items.add(Item.Msg(id, role, text.toString().trim().ifEmpty { "…" }))
            messageIndex[id] = items.size - 1
        }
    }

    fun upsertPart(sessionID: String, messageID: String, part: JSONObject) {
        if (sessionID != currentSession) return
        val known = messageIndex[messageID] ?: return
        val existing = items[known]
        if (existing !is Item.Msg) return
        when (part.optString("type")) {
            "text" -> items[known] = existing.copy(text = part.optString("text"))
            "tool" -> items.add(Item.Tool(part.optString("name", "tool"), part.optJSONObject("state")?.optString("status", "") ?: ""))
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
            val latch = CompletableDeferred<JSONObject>()
            val previous = client.onFrame
            client.onFrame = { f ->
                previous(f)
                if (f.optString("kind") == "response" && f.optString("id") == ticket) latch.complete(f)
            }
            request(JSONObject().put("type", "session.get").put("sessionID", id), ticket)
            val res = runCatching { latch.await() }.getOrNull() ?: return@launch
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
                        sessions.add(SessionRow(sid, s.optString("title", sid), sid in running, s.optLong("updated", 0)))
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
                        if (row != null) sessions[sessions.indexOf(row)] = row.copy(title = title, updated = updated)
                        else sessions.add(SessionRow(sid, title, false, updated))
                        sessions.sortByDescending { it.updated }
                    }
                    "session.deleted" -> sessions.removeAll { it.id == event.optString("sessionID") }
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

    ModalNavigationDrawer(
        drawerState = rememberDrawerState(initialValue = if (drawerOpen) DrawerValue.Open else DrawerValue.Closed),
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = MaterialTheme.colorScheme.background) {
                DrawerContent(
                    sessions = sessions,
                    onSelect = { select(it); drawerOpen = false },
                    onCreate = {
                        request(JSONObject().put("type", "session.create").put("title", "来自手机"))
                        drawerOpen = false
                    },
                    onReconnect = { showConnect = true; drawerOpen = false },
                )
            }
        },
    ) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            topBar = { AppTopBar(wide, sessions, currentSession, onDrawer = { drawerOpen = true }) },
            bottomBar = {
                InputCapsule(
                    enabled = currentSession != null,
                    modelLabel = "本地模型",
                    onSend = { text ->
                        request(JSONObject().put("type", "session.prompt").put("sessionID", currentSession!!).put("text", text).put("delivery", "steer"))
                    },
                    onStop = { currentSession?.let { request(JSONObject().put("type", "session.abort").put("sessionID", it)) } },
                    onNew = { request(JSONObject().put("type", "session.create").put("title", "来自手机")) },
                )
            },
        ) { padding ->
            if (wide) {
                Row(Modifier.padding(padding).fillMaxSize()) {
                    Column(Modifier.weight(0.42f).fillMaxHeight()) {
                        OutlinedTextField(
                            search, { search = it },
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                            placeholder = { Text("搜索", color = LocalMuted.current) },
                            shape = RoundedCornerShape(14.dp),
                            colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant, focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant, unfocusedBorderColor = Color.Transparent, focusedBorderColor = Color.Transparent),
                            singleLine = true,
                        )
                        Spacer(Modifier.height(6.dp))
                        SessionList(sessions, currentSession, search, onSelect = { select(it) }, compact = false)
                    }
                    Box(Modifier.weight(0.58f).fillMaxHeight()) {
                        ConversationBody(items)
                    }
                }
            } else {
                ConversationBody(items)
            }
        }
    }
}

@Composable
fun AppTopBar(wide: Boolean, sessions: List<SessionRow>, current: String?, onDrawer: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onDrawer) {
            Icon(Icons.Outlined.Tune, contentDescription = "菜单", tint = LocalText.current)
        }
        if (!wide) {
            Spacer(Modifier.weight(1f))
            Text(currentSessionTitle(sessions, current), fontSize = 15.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
            Spacer(Modifier.weight(1.2f))
        } else {
            Text("最近记录", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
            Spacer(Modifier.weight(1f))
        }
        IconButton({ }) {
            Icon(Icons.Outlined.VisibilityOff, contentDescription = "隐私", tint = LocalMuted.current)
        }
    }
}

fun currentSessionTitle(sessions: List<SessionRow>, current: String?): String =
    current?.let { id -> sessions.find { it.id == id }?.title } ?: "MCode"

@Composable
fun ConversationBody(items: List<Item>) {
    if (items.isEmpty()) {
        Column(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            MCodeMark(Modifier.size(88.dp))
            Spacer(Modifier.height(18.dp))
            Text("来思考什么？", fontSize = 22.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
            Spacer(Modifier.height(6.dp))
            Text("在下方输入，或从抽屉选择一个会话", fontSize = 13.sp, color = LocalMuted.current)
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                    is Item.Tool -> Row(Modifier.padding(start = 10.dp)) {
                        Text("· ${item.name} ${item.status}", fontSize = 12.sp, color = LocalMuted.current)
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

@Composable
fun SessionList(sessions: List<SessionRow>, current: String?, query: String, onSelect: (String) -> Unit, compact: Boolean, modifier: Modifier = Modifier) {
    val filtered = sessions.filter { it.title.contains(query, true) || it.id.contains(query, true) }
    if (filtered.isEmpty()) {
        Text("没有匹配的会话", fontSize = 13.sp, color = LocalMuted.current, modifier = Modifier.padding(16.dp))
        return
    }
    LazyColumn(modifier.fillMaxSize()) {
        for (s in filtered) {
            item(key = s.id) {
                Row(
                    Modifier.fillMaxWidth().clickable { onSelect(s.id) }.padding(horizontal = 14.dp, vertical = if (compact) 8.dp else 11.dp),
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
) {
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(28.dp))
            Text("MCode", fontFamily = FontFamily.Serif, fontSize = 27.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
            Spacer(Modifier.height(26.dp))
            DrawerItem(Icons.Outlined.Folder, "项目") { }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Code, "Code") { }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Schedule, "定时任务") { }
            Spacer(Modifier.height(18.dp))
            DrawerItem(Icons.Outlined.Settings, "连接设置") { onReconnect() }
            Spacer(Modifier.height(20.dp))
            HorizontalDivider(color = LocalMuted.current.copy(alpha = 0.18f))
            Spacer(Modifier.height(18.dp))
            Text("最近使用", fontSize = 13.sp, color = LocalMuted.current)
            Spacer(Modifier.height(8.dp))
        }
        SessionList(sessions, null, "", onSelect, compact = true, modifier = Modifier.weight(1f))
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(Ember, CircleShape), contentAlignment = Alignment.Center) {
                Text("W", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            }
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.size(44.dp).background(LocalText.current, CircleShape).clickable { },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Outlined.GraphicEq, contentDescription = "语音", tint = LocalBg.current, modifier = Modifier.size(20.dp)) }
            Spacer(Modifier.width(10.dp))
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
fun InputCapsule(enabled: Boolean, modelLabel: String, onSend: (String) -> Unit, onStop: () -> Unit, onNew: () -> Unit) {
    var text by remember { mutableStateOf("") }
    Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp)) {
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
                        Modifier.size(38.dp).background(LocalPill.current, CircleShape).clickable { },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Outlined.Mic, contentDescription = "语音", tint = LocalText.current, modifier = Modifier.size(19.dp)) }
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
                            Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "发送", tint = LocalBg.current, modifier = Modifier.size(19.dp))
                        }
                    }
                }
            }
        }
    }
}
