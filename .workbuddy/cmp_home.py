from PIL import Image
r = Image.open(".workbuddy/shots/CLAUDE-1.png").convert("RGB").crop((0, 0, 900, 1700))
m = Image.open(".workbuddy/shots/MINE-NOW.png").convert("RGB").crop((0, 0, 900, 1700))
w = 450
r = r.resize((w, int(1700 * w / 900)), Image.LANCZOS)
m = m.resize((w, int(1700 * w / 900)), Image.LANCZOS)
out = Image.new("RGB", (w * 2 + 12, r.height), (90, 90, 90))
out.paste(r, (0, 0)); out.paste(m, (w + 12, 0))
out.save(".workbuddy/shots/HOME-CMP.png")
print("left=Claude right=mine")
