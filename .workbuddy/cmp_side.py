from PIL import Image
DPI = 2.5
ref = Image.open(".workbuddy/shots/A_claude.png").convert("RGB")
mine = Image.open(".workbuddy/shots/NOW.png").convert("RGB")

# 左栏并排，同尺度
r = ref.crop((0, 0, 900, 2272))
m = mine.crop((0, 0, 900, 2272))
w = 500
r = r.resize((w, int(2272 * w / 900)), Image.LANCZOS)
m = m.resize((w, int(2272 * w / 900)), Image.LANCZOS)
out = Image.new("RGB", (w * 2 + 12, r.height), (90, 90, 90))
out.paste(r, (0, 0))
out.paste(m, (w + 12, 0))
out.save(".workbuddy/shots/LEFT-SIDE.png")
print("left = Claude, right = mine", out.size)
