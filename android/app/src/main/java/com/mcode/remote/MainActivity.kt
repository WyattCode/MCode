package com.mcode.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

sealed class Item {
    abstract val key: String
    data class Msg(val id: String, val role: String, var text: String) : Item() { override val key = "msg.$id" }
    data class Tool(val name: String, val status: String) : Item() { override val key = "tool.$name.$status.${hashCode()}" }
    data class Perm(val requestId: String, val kind: String, val detail: String) : Item() { override val key = "perm.$requestId" }
    data class Err(val text: String) : Item() { override val key = "err.$text.${hashCode()}" }
    data class Hint(val text: String) : Item() { override val key = "hint.$text.${hashCode()}" }
}

data class SessionRow(val id: String, val title: String, val running: Boolean)

/* ------------------------------------------------------------------ */
/* Remote client                                                       */
/* ------------------------------------------------------------------ */

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
                onState(true)
            }
            override fun onClosed(webSocket: okhttp3.WebSocket, code: Int, reason: String) {
                onState(false)
            }
            override fun onFailure(webSocket: okhttp3.WebSocket, t: Throwable, response: okhttp3.Response?) {
                onState(false)
            }
            override fun onMessage(webSocket: okhttp3.WebSocket, text: String) {
                try {
                    onFrame(JSONObject(text))
                } catch (_: Exception) {
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
    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val wsc = calculateWindowSizeClass(this)
            val dark = androidx.compose.foundation.isSystemInDarkTheme()
            val scheme = if (dark) darkColorScheme() else lightColorScheme()
            MaterialTheme(colorScheme = scheme) {
                App(wsc.widthSizeClass)
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

@Composable
fun App(widthSize: WindowWidthSizeClass) {
    val scope = rememberCoroutineScope()
    val client = remember { RemoteClient() }

    var connected by remember { mutableStateOf(false) }
    var url by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }

    val sessions = remember { mutableStateListOf<SessionRow>() }
    val items = remember { mutableStateListOf<Item>() }
    val messageIndex = remember { mutableStateMapOf<String, Int>() }
    var currentSession by remember { mutableStateOf<String?>(null) }
    var cursor by remember { mutableStateOf(0L) }
    var listReqId by remember { mutableStateOf(0) }

    fun frame(json: JSONObject) = client.send(json.toString())

    fun request(request: JSONObject, id: String) {
        frame(JSONObject().put("kind", "request").put("id", id).put("request", request))
    }
    fun request(request: JSONObject): String {
        val id = "r" + System.nanoTime()
        request(request, id)
        return id
    }

    fun add(item: Item) = items.add(item)
    fun scrollHint() {}

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
            add(Item.Msg(id, role, text.toString().trim().ifEmpty { "…" }))
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
            "tool" -> add(Item.Tool(part.optString("name", "tool"), part.optJSONObject("state")?.optString("status", "") ?: ""))
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
        when (val kind = f.optString("kind")) {
            "remote.welcome" -> {
                cursor = f.optLong("eventId", 0)
                frame(JSONObject().put("kind", "remote.resume").put("cursor", cursor))
                listReqId++
                request(JSONObject().put("type", "session.list"), "list$listReqId")
            }
            "response" -> {
                val id = f.optString("id")
                if (id.startsWith("list")) {
                    sessions.clear()
                    val running = (f.optJSONObject("data")?.optJSONArray("running") ?: return).let { arr ->
                        (0 until arr.length()).map { arr.optString(it) }.toSet()
                    }
                    val list = f.optJSONObject("data")?.optJSONArray("sessions") ?: return
                    for (i in 0 until list.length()) {
                        val s = list.optJSONObject(i) ?: continue
                        sessions.add(SessionRow(s.optString("id"), s.optString("title", s.optString("id")), s.optString("id") in running))
                    }
                    if (currentSession == null && sessions.isNotEmpty()) select(sessions.last().id)
                }
            }
            "remote.event" -> {
                cursor = maxOf(cursor, f.optLong("eventId", 0))
                val event = f.optJSONObject("event") ?: return
                when (event.optString("type")) {
                    "session.updated" -> {
                        val s = event.optJSONObject("session") ?: return
                        val id = s.optString("id")
                        val row = sessions.find { it.id == id }
                        val title = s.optString("title", id)
                        if (row != null) sessions[sessions.indexOf(row)] = row.copy(title = title)
                        else sessions.add(SessionRow(id, title, false))
                    }
                    "session.deleted" -> sessions.removeAll { it.id == event.optString("sessionID") }
                    "message.updated" -> upsertMessage(event.optString("sessionID"), event.optJSONObject("message") ?: return)
                    "message.part.updated" -> upsertPart(event.optString("sessionID"), event.optString("messageID"), event.optJSONObject("part") ?: return)
                    "permission.requested" -> {
                        val r = event.optJSONObject("request") ?: return
                        add(Item.Perm(r.optString("id"), r.optString("kind", "tool"), r.optString("title", "") + " " + r.optJSONObject("meta")?.optString("path", "")))
                    }
                    "permission.resolved" -> items.removeAll { it is Item.Perm && it.requestId == event.optString("requestID") }
                    "session.error" -> add(Item.Err(event.optString("error")))
                }
            }
        }
    }

    var connectedOnce by remember { mutableStateOf(false) }
    client.onState = { up ->
        connected = up
        if (up) connectedOnce = true
    }
    client.onFrame = { f ->
        handle(f)
        // Keep the pending-hook contract: handle() itself manages history latches
        // through the temporary hook installed in select().
    }

    if (!connected && !connectedOnce) {
        ConnectScreen(url, token) { u, t ->
            url = u; token = t
            client.connect(u, t)
        }
        return
    }

    val wide = widthSize >= WindowWidthSizeClass.Medium

    Scaffold(
        topBar = { TopBar(sessions, currentSession, ::select, { request(JSONObject().put("type", "session.create").put("title", "来自手机")) }) },
        bottomBar = {
            InputBar(
                enabled = currentSession != null && connected,
                onSend = { text ->
                    request(JSONObject().put("type", "session.prompt").put("sessionID", currentSession!!).put("text", text).put("delivery", "steer"))
                },
                onStop = { currentSession?.let { request(JSONObject().put("type", "session.abort").put("sessionID", it)) } },
            )
        },
    ) { padding ->
        if (wide) {
            Row(Modifier.padding(padding).fillMaxSize()) {
                Timeline(items, Modifier.weight(1.4f).fillMaxHeight(), onPerm = { requestId, response ->
                    request(JSONObject().put("type", "permission.respond").put("requestID", requestId).put("response", response))
                })
                DetailPane(items, Modifier.weight(1f).fillMaxHeight(), connected)
            }
        } else {
            Timeline(items, Modifier.padding(padding).fillMaxSize(), onPerm = { requestId, response ->
                request(JSONObject().put("type", "permission.respond").put("requestID", requestId).put("response", response))
            })
        }
    }
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

@Composable
fun ConnectScreen(url: String, token: String, onConnect: (String, String) -> Unit) {
    var u by remember { mutableStateOf(url) }
    var t by remember { mutableStateOf(token) }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("MCode 驾驶舱", fontSize = 18.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(bottom = 16.dp))
        OutlinedTextField(u, { u = it }, Modifier.fillMaxWidth().padding(bottom = 8.dp), label = { Text("地址，如 ws://192.168.10.156:7900") }, singleLine = true)
        OutlinedTextField(t, { t = it }, Modifier.fillMaxWidth().padding(bottom = 12.dp), label = { Text("配对令牌") }, singleLine = true)
        Button({ if (u.isNotBlank() && t.isNotBlank()) onConnect(u.trim(), t.trim()) }, Modifier.fillMaxWidth().height(48.dp)) {
            Text("连接")
        }
        Text(
            "与电脑同一网络。地址与令牌只保存在本机。",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TopBar(sessions: List<SessionRow>, current: String?, onSelect: (String) -> Unit, onCreate: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    TopAppBar(
        title = {
            Box {
                val currentTitle = sessions.find { it.id == current }?.title ?: "未选择会话"
                TextButton({ expanded = true }) {
                    Text(if (currentTitle.length > 22) currentTitle.take(22) + "…" else currentTitle, color = MaterialTheme.colorScheme.onSurface)
                }
                DropdownMenu(expanded, { expanded = false }) {
                    for (s in sessions) DropdownMenuItem(
                        text = { Text((if (s.running) "▶ " else "") + (s.title.ifEmpty { s.id }.take(28))) },
                        onClick = { expanded = false; onSelect(s.id) },
                    )
                }
            }
        },
        actions = {
            TextButton(onCreate) { Text("新会话") }
        },
    )
}

@Composable
fun Timeline(items: List<Item>, modifier: Modifier, onPerm: (String, String) -> Unit) {
    LazyColumn(modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                                        if (isUser) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                                        RoundedCornerShape(10.dp),
                                    )
                                    .padding(10.dp),
                            ) {
                                Text(if (isUser) "你" else "MCode", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(item.text.ifEmpty { "…" }, fontSize = 14.sp)
                            }
                        }
                    }
                    is Item.Tool -> Row(Modifier.padding(start = 10.dp)) {
                        Text("· ${item.name} ${item.status}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    is Item.Perm -> PermCard(item, onPerm)
                    is Item.Err -> Text(item.text, fontSize = 12.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(start = 10.dp))
                    is Item.Hint -> Text(item.text, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 10.dp))
                }
            }
        }
    }
}

@Composable
fun PermCard(item: Item.Perm, onPerm: (String, String) -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(10.dp),
    ) {
        Text("权限请求：${item.kind}", fontWeight = FontWeight.Medium, fontSize = 14.sp)
        if (item.detail.isNotBlank()) Text(item.detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button({ onPerm(item.requestId, "once") }, Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)) { Text("允许一次") }
            Button({ onPerm(item.requestId, "always") }, Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)) { Text("总是") }
            Button({ onPerm(item.requestId, "reject") }, Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("拒绝") }
        }
    }
}

@Composable
fun DetailPane(items: List<Item>, modifier: Modifier, connected: Boolean) {
    Column(modifier.padding(14.dp).verticalScroll(rememberScrollState())) {
        Text("会话详情", fontWeight = FontWeight.Medium, fontSize = 15.sp)
        Spacer(Modifier.height(8.dp))
        Text(
            if (connected) "已连接本机 MCode。桌面端仍在原位工作；这里的批准对桌面同样生效。" else "已断开——正在重连。",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        val lastAssistant = items.filterIsInstance<Item.Msg>().lastOrNull { it.role == "assistant" }
        Text("最新回复", fontWeight = FontWeight.Medium, fontSize = 13.sp)
        Text(lastAssistant?.text?.ifEmpty { "…" } ?: "（暂无）", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        val perms = items.filterIsInstance<Item.Perm>()
        Text("待批准（${perms.size}）", fontWeight = FontWeight.Medium, fontSize = 13.sp)
        for (p in perms) Text("· ${p.kind} ${p.detail}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun InputBar(enabled: Boolean, onSend: (String) -> Unit, onStop: () -> Unit) {
    var text by remember { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            text, { text = it },
            Modifier.weight(1f),
            placeholder = { Text("给本机的 MCode 发指令…") },
            maxLines = 4,
        )
        Button(onStop, enabled = enabled, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
            Text("停止", color = MaterialTheme.colorScheme.error)
        }
        Button({ onSend(text); text = "" }, enabled = enabled && text.isNotBlank()) { Text("发送") }
    }
}
