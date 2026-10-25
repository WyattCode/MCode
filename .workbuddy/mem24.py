p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **会话右栏纵向分布是对的**：顶栏 44.8..73.6 / 副标题 96..140.8 / 消息 161.6.. / 
  按钮 236.8 / **离线提示贴底 776..881.6** / 输入框 899.2。
  中间 251~775 是真空白，不是漏扫。
- **浅灰文字要放宽墨迹阈值**：免责声明这类用 `<170` 扫不到，要 `<215`。
  但扫不到时**先怀疑那里本来就没东西**，再怀疑阈值。
- **`.workbuddy/PORT-STATUS.md` 已是最终状态表**：各页实测值 + 未对照项。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
