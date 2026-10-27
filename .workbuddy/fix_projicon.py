p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                MiIcon(
                    "M2 2.6h20M2 8.2h20M3.6 12.4h16.8l-1.6 9.2H5.2z",
                    contentDescription = null,
                    modifier = Modifier.size(67.2.dp),
                    viewBox = 24f,
                    strokeWidth = 1.6f,
                    tint = LocalMuted.current,
                )"""
new = """                /*
                 * Three parts of three different widths, not two rules and a tray.
                 *
                 * Measured on the reference's empty 项目 page at 400 dpi:
                 *
                 *   upper rule   y 321.6..326.0   x 159.2..200.4   41.2 wide
                 *   lower rule   y 335.2..340.0   x 152.0..207.6   55.6 wide
                 *   tray         y 348.8..394.8   x 146.0..213.6   67.6 wide, 46 tall
                 *
                 * So the rules widen downward and the tray is widest - a hopper
                 * seen from the front, which is what the reference draws. This
                 * had `M2 2.6h20M2 8.2h20` - two rules of equal width - and read
                 * as a menu glyph rather than a container.
                 *
                 * Scaled to a 24 grid on the tray's 67.6: the rules are 14.6 and
                 * 19.7 wide, centred on 12; the tray spans 2.3..21.7 and is 16.3
                 * tall with 3.7 of taper.
                 */
                MiIcon(
                    "M4.7 1.6h14.6M2.2 6.4h19.7M2.3 12h19.4l-3.5 10.4H5.8z",
                    contentDescription = null,
                    modifier = Modifier.size(67.6.dp),
                    viewBox = 24f,
                    strokeWidth = 1.6f,
                    tint = LocalMuted.current,
                )"""
assert old in s, "projects empty mark"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("projects empty mark: hopper shape")
