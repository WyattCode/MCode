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
