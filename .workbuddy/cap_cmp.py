from PIL import Image
r = Image.open(".workbuddy/shots/A_claude.png").convert("RGB").crop((0, 330, 400, 480))
m = Image.open(".workbuddy/shots/C4.png").convert("RGB").crop((0, 330, 400, 480))
f = 2.4
r = r.resize((int(400*f), int(150*f)), Image.LANCZOS)
m = m.resize((int(400*f), int(150*f)), Image.LANCZOS)
out = Image.new("RGB", (r.width, r.height*2+10), (200,40,40))
out.paste(r, (0,0)); out.paste(m, (0, r.height+10))
out.save(".workbuddy/shots/CAP-CMP.png")
print("top=Claude bottom=mine")
