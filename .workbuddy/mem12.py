p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **别用 `as` 修 Compose 的类型推断**（2026-10-25 事故）：`if/else` 链推成 `Any` 时，
  `) as Alignment` 会在首帧抛 `ClassCastException` → **启动即崩**。
  改用 `when`（分支同类型）。`Alignment.Top` 与 `Alignment.TopStart` 是不同类。
- **怀疑「页面空白/没渲染」先查进程**：`adb shell pidof com.mcode.remote` 为空 = App 没跑。
  `adb logcat -b crash -d | grep FATAL` 能直接给出异常。
  **（我因没查进程，把 Claude 界面和桌面壁纸当自己 App 量了好几轮）**
- **主页实测**：顶栏 56.4、搜索框 119.2、标题 174.0（墨迹 12.8）、时间墨迹 13.6、
  **行距 60.0**。flat 行不能用卡片的 `.height(68.dp)`。
- **子页面 `onClose`/`onNew` 指向 `LeftMode.Recent`**（主页），只有抽屉 `onSessions` 是 Code。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")