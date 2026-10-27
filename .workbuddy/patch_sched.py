import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                Text("\u5b9a\u65f6\u4efb\u52a1", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                Spacer(Modifier.height(12.dp))
                Text("MCode \u8fd8\u6ca1\u6709\u5b9a\u65f6\u4efb\u52a1\u3002\u684c\u9762\u7aef\u4ee5\u540e\u63d0\u4f9b\u81ea\u52a8\u5316\u65f6\uff0c\u5b83\u4eec\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002", fontSize = 14.sp, color = LocalMuted.current)'''

new = '''                Text("\u5b9a\u65f6\u4efb\u52a1", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                Spacer(Modifier.height(12.dp))
                if (automations.isEmpty()) {
                    // Claude's own empty page, at its sizes: an icon, a title and
                    // the sentence under it.
                    Column(
                        Modifier.fillMaxWidth().padding(top = 40.dp, bottom = 28.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Outlined.Schedule,
                            contentDescription = null,
                            tint = LocalMuted.current.copy(alpha = 0.55f),
                            modifier = Modifier.size(57.dp),
                        )
                        Spacer(Modifier.height(18.dp))
                        Text("\u6682\u65e0\u5b9a\u65f6\u4efb\u52a1", fontSize = 15.sp, color = LocalText.current)
                        Spacer(Modifier.height(8.dp))
                        Text("\u8ba9 MCode \u6309\u8ba1\u5212\u8fd0\u884c\u4efb\u52a1\u3002", fontSize = 13.sp, color = LocalMuted.current)
                    }
                } else {
                    for ((_, title, nextAt) in automations) {
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.Schedule, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(title, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (nextAt > 0L) {
                                    val when_ = android.text.format.DateFormat.format("MM-dd HH:mm", nextAt).toString()
                                    Text("\u4e0b\u6b21\uff1a$when_", fontSize = 11.sp, color = LocalMuted.current)
                                }
                            }
                        }
                    }
                }'''

assert old in s, "scheduled page body not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("scheduled page rebuilt")