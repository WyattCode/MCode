p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                    Column(Modifier.weight(1f - leftFraction).fillMaxHeight()) {
                        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {"""
new = """                    Column(Modifier.weight(1f - leftFraction).fillMaxHeight()) {
                        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
                        /*
                         * The pane is blank on the pages that own the left column.
                         *
                         * Photographed on the reference's 项目, 定时任务 and
                         * 产物 screens: the right pane is empty page - not a
                         * conversation header over nothing. This drew the
                         * header regardless, so a back arrow floated at
                         * x 379.6..392.4 on a page that has no conversation to
                         * go back from, and a reader tapping it went somewhere
                         * they had not asked for.
                         */
                        if (leftMode != LeftMode.Projects &&
                            leftMode != LeftMode.Scheduled &&
                            leftMode != LeftMode.Artifacts &&
                            leftMode != LeftMode.Plugins
                        ) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {"""
assert old in s, "right pane header"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("right pane header: guarded")
