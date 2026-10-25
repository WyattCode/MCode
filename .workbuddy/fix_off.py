p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
lines = open(p, encoding="utf-8").read().split("\n")
# 只改 3770 附近那一处（主页标题）
for i in range(3760, 3775):
    if ".offset(x = (-5.2).dp)," in lines[i]:
        lines[i] = "                                .offset(x = 5.dp),"
        print("line %d: -5.2 -> +5.0" % (i+1))
        break
open(p, "w", encoding="utf-8").write("\n".join(lines))
