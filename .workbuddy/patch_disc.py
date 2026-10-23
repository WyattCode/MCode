import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''    if (!atEnd) {
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 10.dp)'''

new = '''    /*
     * The disc floats over the transcript, so it must not sit on top of the
     * one row that is waiting for the reader: a pending approval. While one is
     * on screen (a card, or its 「拒绝并说明」 field open under it) the disc is a tap
     * that might approve or explain instead of scrolling, and it covered the
     * card's own buttons. It steps aside until the queue is clear.
     */
    if (!atEnd && items.none { it is Item.Perm }) {
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 10.dp)'''

assert old in s, "disc block not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("disc yields to a pending card")