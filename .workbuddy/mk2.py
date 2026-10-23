from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = '销售'
ws.append(['地区', '金额', '备注'])
ws.append(['华东', 1200, '稳'])
ws.append(['华南', 980, None])
ws2 = wb.create_sheet('汇总')
ws2['A1'] = '合计'
ws2['B1'] = 2180
wb.save(r'D:/Apps/MCode/test.xlsx')
print('xlsx ok')
