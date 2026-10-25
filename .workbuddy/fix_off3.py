p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
lines = open(p, encoding="utf-8").read().split("\n")
for i in range(3760, 3775):
    if ".offset(x = (-5.8).dp)," in lines[i]:
        lines[i] = "                                .offset(x = (-0.8).dp),"
        print("line %d: -5.8 -> -0.8 (centre 174.8 -> ~179.8)" % (i+1))
        break
open(p, "w", encoding="utf-8").write("\n".join(lines))
