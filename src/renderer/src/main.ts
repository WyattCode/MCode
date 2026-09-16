import { createApp } from "vue"
import { createPinia } from "pinia"
import App from "./App.vue"
import { installTips } from "./lib/tip"
import { installModal } from "./lib/modal"
import { installErrorPage } from "./lib/error-page"
import { watchScrolling } from "./lib/scrollbars"
import { installSelectContent } from "./lib/select-content"
import { installFocusRing } from "./lib/focus-ring"
import "./styles/base.css"

const app = createApp(App)
app.use(createPinia())
installTips(app)
installModal(app)
/*
 * Before the mount, not after: a component that throws on its very first render
 * fails inside mount(), and a handler installed on the line below would never
 * have been reached.
 */
installErrorPage(app)
watchScrolling()
installSelectContent()
installFocusRing()
app.mount("#app")
