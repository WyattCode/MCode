from PIL import Image
r = Image.open(".workbuddy/shots/A_claude.png").convert("RGB").crop((0, 0, 900, 2272))
m = Image.open(".workbuddy/shots/V1.png").convert("RGB").crop((0, 0, 900, 2272))
w = 460
r = r.resize((w, int(2272 * w / 900)), Image.LANCZOS)
m = m.resize((w, int(2272 * w / 900)), Image.LANCZOS)
out = Image.new("RGB", (w * 2 + 14, r.height), (80, 80, 80))
out.paste(r, (0, 0)); out.paste(m, (w + 14, 0))
out.save(".workbuddy/shots/SIDE2.png")
print("left=Claude  right=mine")
