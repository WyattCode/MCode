p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 顶栏->设备: 目标 41.6，实测 66.8，多 25.2。38.4 - 25.2 = 13.2
s = s.replace(
    "modifier = Modifier.padding(start = 28.8.dp, top = 38.4.dp, bottom = 22.8.dp),",
    "modifier = Modifier.padding(start = 28.8.dp, top = 13.2.dp, bottom = 22.8.dp),", 1)

# 添加设备->会话: 目标 44.0，实测 58.0，多 14。40 - 14 = 26
s = s.replace(
    "                                .padding(start = 28.8.dp, end = 20.4.dp, top = 40.dp, bottom = 8.dp),",
    "                                .padding(start = 28.8.dp, end = 20.4.dp, top = 26.dp, bottom = 8.dp),", 1)

open(p, "w", encoding="utf-8").write(s)
print("gaps trimmed: device top 13.2, sessions top 26")