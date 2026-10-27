from PIL import Image
r = Image.open(".workbuddy/shots/A_claude.png").convert("RGB").crop((880, 0, 3408, 2272))
m = Image.open(".workbuddy/shots/D1.png").convert("RGB").crop((880, 0, 3408, 2272))
w = 620
r = r.resize((w, int(2272 * w / 2528)), Image.LANCZOS)
m = m.resize((w, int(2272 * w / 2528)), Image.LANCZOS)
out = Image.new("RGB", (w * 2 + 14, r.height), (80, 80, 80))
out.paste(r, (0, 0)); out.paste(m, (w + 14, 0))
out.save(".workbuddy/shots/RIGHT-SIDE.png")
print("left=Claude right=mine", out.size)
