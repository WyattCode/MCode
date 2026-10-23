from docx import Document
d = Document()
d.add_heading('季度回顾', 0)
d.add_paragraph('这一季的要点如下。')
d.add_heading('进展', level=1)
for t in ['完成 A 模块', '完成 B 模块', '启动 C 模块']:
    d.add_paragraph(t, style='List Bullet')
tb = d.add_table(rows=2, cols=2)
tb.cell(0,0).text = '项目'
tb.cell(0,1).text = '状态'
tb.cell(1,0).text = 'A'
tb.cell(1,1).text = '完成'
p = d.add_paragraph()
r = p.add_run('加粗的一句')
r.bold = True
d.save(r'D:/Apps/MCode/test.docx')
print('ok')
