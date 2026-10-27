import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                            Box(Modifier.size(40.dp).clickable { showTasks = true }, contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.Schedule, contentDescription = "\u4efb\u52a1", tint = LocalText.current, modifier = Modifier.size(19.dp))
                            }'''

new = '''                            Box(Modifier.size(40.dp).clickable { showTasks = true }, contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.Schedule, contentDescription = "\u4efb\u52a1", tint = LocalText.current, modifier = Modifier.size(19.dp))
                            }
                            /*
                             * While a turn is in flight Claude puts an amber ring
                             * beside the clock - 239,181,68, 16dp across - instead
                             * of leaving the header still. It reads as work in
                             * progress and as the way to stop it, which is what the
                             * running turn needs from the top of the screen.
                             */
                            if (runningNow) {
                                Box(
                                    Modifier.size(40.dp).clickable { currentSession?.let { stopHere(it) } },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    androidx.compose.material3.CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        strokeWidth = 2.dp,
                                        color = Color(0xFFEFB544),
                                    )
                                }
                            }'''

assert old in s, "clock button not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("amber ring added")