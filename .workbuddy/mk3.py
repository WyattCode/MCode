from pptx import Presentation
from pptx.util import Inches
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0])
s.shapes.title.text = '产品发布'
s.placeholders[1].text = '2026 年第四季度'
s2 = p.slides.add_slide(p.slide_layouts[1])
s2.shapes.title.text = '要点'
s2.placeholders[1].text = '更快\n更稳\n更省'
p.save(r'D:/Apps/MCode/test.pptx')
print('pptx ok')
