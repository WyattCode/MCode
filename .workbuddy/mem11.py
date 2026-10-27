p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **平板保活（不充电）完整配方**，缺一不可：
  `screen_off_timeout=2147483647`、**`screen_brightness_mode 0`**（← 关键，
  自动亮度会把背光压到 0，造成「Awake 但截图全黑」）、`screen_brightness 200`、
  `svc power stayon true`、`locksettings set-disabled true`。
- **设备有 PIN 锁**：`locksettings set-disabled true` 不即时生效；
  `isKeyguardShowing=true` 时 adb 解不开，**必须人工输一次密码**。
- **`mCurrentFocus = com.android.systemui`** = 锁屏或通知面板挡着，不是崩溃。
  查 `dumpsys window|grep isKeyguardShowing`。
- **截图一律用 `.workbuddy/pad_awake.py <out.png>`**：自动找端口（会漂移）、
  唤醒、黑帧重试 6 次。别再手写 adb 截图。
- **抽屉只有 4 项**：项目 / Code / Artifacts / 定时任务。**没有「最近记录」**
  （那是默认页，靠返回键退回）。2026-10-25 我曾凭猜测加过，已移除。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")