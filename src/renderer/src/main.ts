import { createApp } from "vue"
import { createPinia } from "pinia"
import App from "./App.vue"
import { installTips } from "./lib/tip"
import { installModal } from "./lib/modal"
import { installErrorPage } from "./lib/error-page"
import { watchScrolling } from "./lib/scrollbars"
import { installSelectContent } from "./lib/select-content"
import { installFocusRing } from "./lib/focus-ring"
import { installAnnouncer } from "./lib/announce"
import { detectLanguage, loadLanguage, rememberedLanguage } from "./lib/i18n"
import { loadMath } from "./lib/markdown"
import "./styles/base.css"

/*
 * Most language tables are a chunk of their own (lib/i18n.ts). The one this
 * window last drew in, and the machine's own, are the likeliest the settings
 * will name, so they are asked for now, beside the mount rather than before
 * it: the settings arrive from the backend well after both are in hand, and
 * the switch is then as immediate as it was with every table in the entry.
 */
for (const id of new Set([rememberedLanguage(), detectLanguage()])) if (id) void loadLanguage(id)

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
installAnnouncer()
app.mount("#app")

/*
 * KaTeX is its own chunk, off the path to the first paint; fetched once the
 * window is at rest, so a formula in the first reply opened is usually drawn
 * as a formula straight away rather than as its source for a moment.
 */
const whenIdle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1500))
whenIdle(() => void loadMath(), { timeout: 4000 })
