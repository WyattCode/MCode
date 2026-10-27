p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **主页右栏 = 会话页，八段全部与 Claude 吻合**：状态栏 11.2 / 顶栏 44.8 / 副标题 96 /
  消息 161.6 / 回复 204.8 / 按钮 236.8 / **提示区 776 贴底** / 输入框 899.2。
  中间 251~775 是空白——提示**不紧跟消息，而是贴底**。这个布局早就对了。
- **缩略图误判第 5 次**：看到「左栏右边露出 ◀」以为有 bug，
  实际是我裁图只到 404dp、把 400.8 起始的返回箭头切断了。
  **不看缩略图判断任何形状或存在性。**
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
