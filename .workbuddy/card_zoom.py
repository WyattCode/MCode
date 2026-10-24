from PIL import Image
# Claude 卡片在 y 640..790（从并排图反推：图高1262对应2272 -> 卡 y≈355*1.8）
r = Image.open(".workbuddy/shots/A_claude.png").convert("RGB").crop((0, 640, 900, 820))
m = Image.open(".workbuddy/shots/V1.png").convert("RGB").crop((0, 640, 900, 820))
f = 1.4
r = r.resize((int(900*f), int(180*f)), Image.LANCZOS)
m = m.resize((int(900*f), int(180*f)), Image.LANCZOS)
out = Image.new("RGB", (r.width, r.height*2+10), (200,40,40))
out.paste(r, (0,0)); out.paste(m, (0, r.height+10))
out.save(".workbuddy/shots/CARD-ZOOM.png")
print("top=Claude bottom=mine")
