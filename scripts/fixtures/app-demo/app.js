// The demo app the app tool is checked against: tabs, a counter, a settings form and a confirm dialog.
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
  count += 1
  show()
})
$("minus").addEventListener("click", () => {
  count -= 1
  show()
})
$("reset").addEventListener("click", () => {
  count = 0
  show()
})

$("save").addEventListener("click", () => {
  const nick = $("nick").value.trim()
  const lang = $("lang").selectedOptions[0].text
  $("saved").textContent = `已保存：${nick || "（未填昵称）"}，${lang}，${$("dark").checked ? "深色" : "浅色"}`
})

$("remove").addEventListener("click", () => $("confirm").showModal())
$("cancel").addEventListener("click", () => $("confirm").close())
$("ok").addEventListener("click", () => {
  $("confirm").close()
  $("status").textContent = "账户已删除"
})

// A button that fails, so a check can see the page's own errors reach the model.
$("broken").addEventListener("click", () => {
  console.error("检查更新失败：服务器没有响应")
  setTimeout(() => {
    throw new Error("update check crashed")
  })
})
