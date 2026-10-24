p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **不充电时 adb 唤不亮屏幕**（2026-10-24 实测 5 种全败）：`screen_off_timeout` 最大值、
  `svc power stayon true`、`locksettings set-disabled`、每 20s 发 `KEYCODE_WAKEUP`、
  `am start` —— 命令都返回成功，屏幕依旧黑。
  **`stay_on_while_plugged_in` 是唯一可靠机制，但必须插电。**
  别写 adb 循环保活脚本，无效且费 token。正解：插电源 + `svc power stayon true`。
- **平板无线端口会漂移**（42407 -> 35909）。`adb connect` 被拒绝 != 设备离线，
  直接问用户当前端口最快，别硬猜。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")