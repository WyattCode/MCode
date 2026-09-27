const $ = (id) => document.getElementById(id)

for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[role=tab]")) {
      other.setAttribute("aria-selected", String(other === tab))
      $(other.getAttribute("aria-controls")).hidden = other !== tab
    }
  })
}

$("greet").addEventListener("click", () => {
  $("greeting").textContent = "你好！"
})

let count = 0
const show = () => ($("value").textContent = String(count))
$("plus").addEventListener("click", () => {
  count = Logic.plus(count)
  show()
})
$("minus").addEventListener("click", () => {
  count = Logic.minus(count)
  show()
})
$("reset").addEventListener("click", () => {
  count = Logic.reset()
  show()
})

$("save").addEventListener("click", () => {
  $("saved").textContent = Logic.savedText($("nick").value.trim(), $("lang").selectedOptions[0].text, $("dark").checked)
})

$("remove").addEventListener("click", () => $("confirm").showModal())
$("cancel").addEventListener("click", () => $("confirm").close())
$("ok").addEventListener("click", () => {
  $("confirm").close()
  $("status").textContent = "账户已删除"
})
