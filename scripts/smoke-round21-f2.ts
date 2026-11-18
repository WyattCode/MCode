/**
 * Round 21, lane F2: the settings dialog against MiMo 26.920 - the shell and
 * its navigation column, the pages' rhythm, 外观, 快捷键, MCP, 环境, 已归档 and
 * the whole of 模型. Each check fails on the code before its fix.
 *
 * These live in markup and CSS, so they are read from the source; the lane's
 * Electron probe measured the result in a real window, light and dark.
 * smoke.ts calls `roundTwentyOneLaneFTwoChecks` with its own check and section.
 * `root` is the checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** The bodies of every rule whose selector (or last selector of a list) is exactly `selector`, in order. */
function rule(css: string, selector: string): string {
  const bodies: string[] = []
  for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
    const open = css.indexOf("{", at)
    bodies.push(css.slice(open + 1, css.indexOf("}", open)))
  }
  return bodies.join("\n")
}

export async function roundTwentyOneLaneFTwoChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")
  const settings = code(await read("src/renderer/src/components/SettingsDialog.vue"))
  const template = settings.slice(settings.indexOf("<template>"), settings.lastIndexOf("</template>"))
  const style = settings.slice(settings.indexOf("<style"))
  const models = code(await read("src/renderer/src/components/ModelsPage.vue"))
  const modelsStyle = models.slice(models.indexOf("<style"))
  const form = code(await read("src/renderer/src/components/CustomProviderForm.vue"))
  const formStyle = form.slice(form.indexOf("<style"))
  const clone = code(await read("src/renderer/src/components/ProviderCloneDialog.vue"))
  const confirm = code(await read("src/renderer/src/components/ConfirmDialog.vue"))
  const connect = code(await read("src/renderer/src/components/ConnectDialog.vue"))
  const i18n = await read("src/renderer/src/lib/i18n.ts")
  const tokens = code(await read("src/renderer/src/styles/tokens.css"))

  // ------------------------------------------------------------------ F2-1
  section("Round 21 (F2-1): the settings dialog's red states are drawn, not dropped")
  {
    const owned = [settings, models, form, clone, connect]
    check("--text-critical is defined now, so the settings reds may name it", /--text-critical: #d23f3f;/.test(tokens))
    const pill = rule(style, ".mcp-status.err")
    check("MiMo's failure pill: --color-err under an 8% fill and a 35% ring", /color: var\(--text-critical\);/.test(pill) && /--text-critical\) 8%/.test(pill) && /--text-critical\) 35%/.test(pill), pill)
    check("its tools error line is the same red", /color: var\(--text-critical\);/.test(rule(style, ".mcp-tools-hint.err")))
    const conflict = rule(style, ".keys-record-box.conflict")
    check("a shortcut conflict is red-500, border, fill and text", /#fb2c36/.test(conflict) && (conflict.match(/#fb2c36/g) ?? []).length === 3, conflict)
    check("so is the conflict line and the delete hover", /color: #fb2c36;/.test(rule(style, ".keys-record-conflict")) && /color: #fb2c36;/.test(rule(style, ".keys-icon.danger:hover")))
    check("a field MiMo will not accept is ringed in red-400", /border-color: #ff6467;/.test(rule(formStyle, ".cp-in.bad")) && /border-color: #ff6467;/.test(rule(clone, ".field-in.bad")))
  }

  // ------------------------------------------------------------------ F2-2
  section("Round 21 (F2-2): 外观 - the segments have a dark value and the icon grid is a card")
  {
    check("MiMo's primary pair in dark on the chosen segment", /:root\[data-theme="dark"\] \.choice-btn\.on \{\s*color: #0d0d0d;\s*background: #ececec;/.test(style))
    check("a resting segment is mut, not the step below it", /color: var\(--text-base\);/.test(rule(style, ".choice-btn")))
    check("the grid is itself the card", /<div class="card gallery"/.test(template))
    const gallery = rule(style, ".card.gallery")
    check("four equal columns, 18/12 apart, 18 by 16 in", /grid-template-columns: repeat\(4, 1fr\);/.test(gallery) && /gap: 18px 12px;/.test(gallery) && /padding: 18px 16px;/.test(gallery), gallery)
    const tile = rule(style, ".tile")
    check("a cell carries nothing of its own", /padding: 0;/.test(tile) && /border: 0;/.test(tile) && /gap: 8px;/.test(tile), tile)
    const art = rule(style, ".tile-art")
    check("the thumb is 60 square on a 14px corner under an inset hairline", /width: 60px;/.test(art) && /height: 60px;/.test(art) && /border-radius: 14px;/.test(art) && /box-shadow: inset 0 0 0 1px #00000014;/.test(art), art)
    check("and it keeps that 60 for a rasterised artwork too", /object-fit: cover;/.test(art) && !/^img\.tile-art/m.test(style))
    check("hover rings it, the chosen one is ringed twice", /0 0 0 2px #f1f0ec/.test(style) && /0 0 0 2px #fffefd, 0 0 0 4px #151c13/.test(style))
    // Since the new mark (2026-09-27) every tile is the colourway's own generated file, shown at the thumb's size.
    // Read raw: the glob's own "/*.png" would be taken for the start of a comment by code() above.
    const raw = await read("src/renderer/src/components/SettingsDialog.vue")
    check("each tile is its colourway's own file, at the thumb's own size", /import\.meta\.glob<string>\("@resources\/app-icons\/\*\.png"/.test(raw) && /<img class="tile-art" :src="tile\.image" width="60" height="60"/.test(template))
  }

  // ------------------------------------------------------------------ F2-3
  section("Round 21 (F2-3): the shell, the rhythm and the usage cards")
  {
    const dialog = rule(style, ".dialog")
    check("MiMo's settings-full gives up a fixed 48 and 88, not a share of the window", /width: min\(960px, 100vw - 48px\);/.test(dialog) && /height: min\(660px, 100vh - 88px\);/.test(dialog), dialog)
    check("--shadow-pop replaces the stale --shadow-lg", /box-shadow: var\(--shadow-pop\);/.test(dialog) && !/--shadow-lg/.test(style))
    check("it opens on MiMo's --ease-enter", /settings-overlay-in 0\.18s cubic-bezier\(0\.2, 0\.7, 0\.2, 1\)/.test(style))
    check("the page carries the thin 9px bar", /class="content u-scrollbar-thin"/.test(template))
    check("sc-h1 and sc-sec are 26 off what follows", /margin: 0 0 26px;/.test(rule(style, "h2")) && /margin: 26px 0 4px;/.test(rule(style, "h3")))
    const card = rule(style, ".card")
    check("a card's inset is the row's 16 and it carries its own 8 of margin", /padding: 0 16px;/.test(card) && /margin-bottom: 8px;/.test(card), card)
    check("the rule between two cards is gone", !/\.card \+ \.card \{/.test(style))
    check("sc-sub no longer pulls itself up into the title", /margin: 0 0 14px;/.test(rule(style, ".page-sub")) && /margin: 8px 0 14px;/.test(rule(style, ".note")))
    check("the import note and the example label are 14 down", /\.page-sub\.mcp-skills-note,\n\.page-sub\.mcp-example-label \{\s*margin-top: 14px;/.test(style))
    check("the worktree count has no margin of its own", /margin: 0;/.test(rule(style, ".wt-status")))
    check("the figures sit on a row's 16 rather than flush", /<div class="usage-block">/.test(template) && /padding-block: 16px;/.test(rule(style, ".usage-block")))
    check("a dialog's scrim is bg-black/50 in both schemes", /background: #00000080;/.test(rule(confirm, ".scrim")) && /background: #00000080;/.test(rule(clone, ".scrim")) && /background: #00000080;/.test(rule(style, ".vs-scrim")))
    // Lane F1 landed the token in the same round, so the dialog now names it rather than MiMo's literal.
    check("and its lift is --shadow-pop", /box-shadow: var\(--shadow-pop\);/.test(rule(confirm, ".dialog")))
  }

  // ------------------------------------------------------------------ F2-4
  section("Round 21 (F2-4): the navigation column, measured on MiMo's own")
  {
    const nav = rule(style, ".nav")
    check("240 wide, not 241", /width: 240px;/.test(nav) && /min-width: 240px;/.test(nav) && !/241px/.test(style), nav)
    check("every inset is 10", /padding: 18px 10px 0;/.test(rule(style, ".nav-top")) && /padding-inline: 10px 0;/.test(rule(style, ".nav-scroll")))
    check("the title hangs on 2 above and 10 below", /padding: 2px 10px 10px;/.test(rule(style, ".nav-title")))
    check("a group label on 12 above and 4 below, with no margin rule left", /padding: 12px 10px 4px;/.test(rule(style, ".nav-group")) && !/\.nav-item \+ \.nav-group/.test(style) && !/\.nav-group:first-child/.test(style))
    const item = rule(style, ".nav-item")
    check("a row takes its height from 8 of padding and its own 2 of margin", /padding: 8px 10px;/.test(item) && /margin-bottom: 2px;/.test(item), item)
    const search = rule(style, ".nav-search")
    check("the search is inset by 6 inside the column's 10 and grows with the font", /margin: 6px;/.test(search) && /width: calc\(100% - 12px\);/.test(search) && /padding: 6px 10px;/.test(search) && !/^  height:/m.test(search), search)
    check("its rule is --color-line, light and dark", /border: 1px solid #f0ebe5;/.test(search) && /:root\[data-theme="dark"\] \.nav-search \{\s*border-color: #2e2e2e;/.test(style))
    check("hover and active are MiMo's own fills, not mixes of the ink", /background: #f1f0ec;/.test(rule(style, ".nav.mouse-active .nav-item:hover")) && /background: #eeedec;/.test(style) && !/color-mix\(in srgb, var\(--text-strong\) 5%, transparent\)/.test(style))
    check("the opencode-era column rules are gone", !/--surface-raised-hover/.test(style) && !/opencode's own settings tabs-list/.test(settings))
  }

  // ------------------------------------------------------------------ F2-5
  section("Round 21 (F2-5): the mut/dim sweep and the MCP page")
  {
    for (const [name, selector] of [
      ["the dialog close", ".close"],
      ["the MCP status pill", ".mcp-status"],
      ["its tools hint", ".mcp-tools-hint"],
      ["its tools head", ".mcp-tools-head"],
      ["a tool's description", ".mcp-tool-desc"],
      ["the MCP form's labels", ".mcp-label"],
      ["its HTTP hint", ".mcp-hint"],
      ["the shortcuts column head", ".keys-cols"],
      ["个性化's help box", ".ci-help"],
      ["the worktree empty line", ".wt-empty-desc"],
      ["the environment back link", ".env-back"],
      ["a local environment's path", ".env-local-path"],
    ] as const) {
      check(`${name} is mut`, /color: var\(--text-base\);/.test(rule(style, selector)), selector)
    }
    check("a tool's own name takes MiMo's txt ink", /color: var\(--text-body\);/.test(rule(style, ".mcp-tool-name")))
    // R22-L1 took the unit on to --text-base; the shortcut description has no
    // MiMo counterpart to read a tone off, so it stays where F2 put it.
    check("the px unit and a shortcut's description move off --text-weaker", /color: var\(--text-base\);/.test(rule(style, ".unit")) && /color: var\(--text-weak\);/.test(rule(style, ".keys-desc")))
    check("the worktree tag is legible", /color: var\(--text-weak\);/.test(rule(style, ".wt-tag")))
    const panel = rule(style, ".mcp-tools-panel")
    check("MiMo draws no rule under the tools panel, and pulls it 6 up on the card's 16", /margin-top: -6px;/.test(panel) && /padding: 4px 16px 14px;/.test(panel) && !/border-bottom/.test(panel), panel)
    check("its control row does not wrap", !/flex-wrap: wrap;/.test(rule(style, ".mcp-ctrl")))
    check("添加请求头 sits 12 clear", /margin-bottom: 12px;/.test(rule(style, ".mcp-add-row")))
    check("the select trigger is px-3 on both sides", /padding: 0 12px;/.test(rule(style, ".content :deep(.trigger)")))
  }

  // ------------------------------------------------------------------ F2-6
  section("Round 21 (F2-6): 环境, 快捷键, 已归档 and the leftovers")
  {
    check("the project folder is MiMo's inline sr-ic", /width: 18px;[\s\S]{0,80}vertical-align: -3px;[\s\S]{0,60}color: currentColor;/.test(rule(style, ".env-project-name svg")) && !/\.env-project-name \{/.test(style))
    check("the refresh arrow's head is a path of its own", /<path d="M21 12A9 9 0 1 1 18\.36 5\.64" \/>/.test(template) && /<path d="M16 9h5V4" \/>/.test(template))
    check("the instructions box focuses on dim and rules itself with --color-line", /border-color: var\(--text-weak\);/.test(rule(style, ".ci-input:focus")) && !/border-color: #3d3d3d;\n\}/.test(rule(style, ':root[data-theme="dark"] .ci-help')))
    check("了解更多 no longer underlines on hover", !/\.ci-link:hover/.test(style))
    check("`.line.stack` was dead CSS", !/\.line\.stack/.test(settings))
    check("the key cap carries shadow-sm", /box-shadow: 0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a;/.test(rule(style, ".keys-kbd")))
    check("the recording pulse bottoms out at .5", /@keyframes keys-record-pulse \{\s*50% \{\s*opacity: 0\.5;/.test(style))
    check("the shortcut pencil is filled, keeping MCode's focus reveal", /<svg viewBox="0 0 16 16" fill="currentColor" fill-rule="evenodd"/.test(template) && /\.keys-edit:focus-visible \{/.test(style))
    check("a search hit flashes side-active in both schemes", /background: #f1f0ec;/.test(style) && /@keyframes sr-hit-dark/.test(style) && !/var\(--surface-key\)/.test(style))
    const keysSearch = rule(style, ".keys-search")
    check("the shortcuts search and table sit on the card colour", /background: #ffffff;/.test(keysSearch) && /border: 1px solid #f3efeb;/.test(keysSearch) && /background: #ffffff;/.test(rule(style, ".keys-table")))
    check("nothing on that page is mixed from the ink any more", !/13\.4%/.test(style) && !/var\(--surface-menu\)/.test(style))
    check("its row hover is --color-side, which does show in light", /background: #f8f7f5;/.test(rule(style, ".keys-row:hover")))
    check("已归档 sits on bg-bg inside --color-line", /background: #fffefd;/.test(rule(style, ".batch-bar")) && /background: #fffefd;/.test(rule(style, ".archived-manage")) && /:root\[data-theme="dark"\] \.batch-bar,/.test(style))
    check("its delete is --color-del washed with red-50", /color: #e5484d;/.test(rule(style, ".archived-delete")) && /background: #fef2f2;/.test(rule(style, ".archived-delete:hover:not(:disabled)")))
    check("重启更新 is the primary pair", /background: #151c13;/.test(rule(style, ".ctl-btn.update-install")))
  }

  // ------------------------------------------------------------------ F2-7
  section("Round 21 (F2-7): the 模型 page - cards, the dock, the buttons and the fields")
  {
    check("the page's blocks are 16 apart", /gap: 16px;/.test(rule(modelsStyle, ".models-page")) && /gap: 16px;/.test(rule(formStyle, ".cp")))
    check("and one model card is 8 from the next", /margin-top: -8px;/.test(rule(formStyle, ".cp-model + .cp-model")))
    const cpCard = rule(formStyle, ".cp-card")
    check("the provider's fields are a set-card", /border-radius: 16px;/.test(cpCard) && /background: #ffffff;/.test(cpCard) && /border: 1px solid #f3efeb;/.test(cpCard), cpCard)
    const cpRow = rule(formStyle, ".cp-row")
    check("its rows are 16 deep and centred, as MiMo's sr-single is", /padding: 16px 0;/.test(cpRow) && /align-items: center;/.test(cpRow), cpRow)
    check("a label is 14/500 with no padding-top hack", /font-size: calc\(14px \* var\(--ui-font-scale, 1\)\);/.test(rule(formStyle, ".cp-label")) && !/padding-top: 9px;/.test(formStyle))
    check("the connected vendor's card is the same one", /border-radius: 16px;/.test(rule(modelsStyle, ".card")) && /padding: 16px 0;/.test(rule(modelsStyle, ".line")))

    check("the dock is portalled into the dialog shell", /<Teleport v-if="dockHost" :to="dockHost">/.test(models) && /document\.querySelector<HTMLElement>\("\[data-settings-overlay\] \.dialog"\)/.test(models))
    const dock = rule(modelsStyle, ".dock")
    check("MiMo positions it against that shell", /position: absolute;/.test(dock) && /bottom: 8px;/.test(dock) && /inset-inline-start: 320px;/.test(dock) && /inset-inline-end: 80px;/.test(dock), dock)
    check("and glazes it", /backdrop-filter: blur\(22px\) saturate\(165%\);/.test(dock) && /box-shadow: 0 8px 28px #00000024, inset 0 1px #ffffff47;/.test(dock))
    check("the page ends with MiMo's 130px floor", /class="dock-floor"/.test(models) && /height: 130px;/.test(rule(modelsStyle, ".dock-floor")))
    check("删除 and 克隆供应商 carry MiMo's 15px glyphs 6 from their words", /gap: 6px;/.test(rule(modelsStyle, ".dock-btn")) && /width: 15px;/.test(rule(modelsStyle, ".dock-btn svg")))
    check("deleting is the one red hover", /color: #fb2c36;[\s\S]{0,120}border-color: #ffa2a2;/.test(rule(modelsStyle, ".dock-btn.danger:hover:not(:disabled)")))

    const primary = rule(modelsStyle, ".primary")
    check("save is MiMo's sm primary, not a 32px pill", /height: calc\(26px \* var\(--ui-font-scale, 1\)\);/.test(primary) && /border-radius: 8px;/.test(primary) && /background: #151c13;/.test(primary), primary)
    const cpBtn = rule(formStyle, ".cp-btn")
    check("测试连接 and 添加模型 are MiMo's secondary, 26 or 28 in a row", /background: #f1f1f1;/.test(cpBtn) && /border: 0;/.test(cpBtn) && /height: calc\(28px \* var\(--ui-font-scale, 1\)\);/.test(rule(formStyle, ".cp-probe .cp-btn")), cpBtn)

    const input = rule(formStyle, ".cp-in")
    check("a field is MiMo's shared input: 6 round, 12 in, over nothing", /border-radius: 6px;/.test(input) && /padding: 0 12px;/.test(input) && /background: transparent;/.test(input) && /border: 1px solid #e3e3e0;/.test(input), input)
    check("it focuses on dim", /border-color: var\(--text-weak\);/.test(rule(formStyle, ".cp-in:focus")))
    check("nothing on the page is monospaced any more, and a read-only id is not greyed", !/cp-in mono/.test(form) && !/\.cp-in\.mono/.test(formStyle) && !/\.cp-in\[readonly\]/.test(formStyle))
    check("the clone dialog matches, with MiMo's placeholder", /placeholder="my-provider-copy"/.test(clone) && !/font-family: var\(--font-mono\);/.test(clone))

    check("the picker is filled from the test's results and the catalogue", /for \(const id of probe\.value\.modelIds\) merged\.set\(id, known\(id\)\?\.name \?\? ""\)/.test(form) && /for \(const model of provider\.models\) if \(!merged\.has\(model\.id\)\) merged\.set\(model\.id, model\.name\)/.test(form))
    check("a row draws the id and its display name", /<span class="cp-option-id">\{\{ choice\.id \}\}<\/span>/.test(form) && /data-model-combo-name/.test(form) && /max-width: 45%;/.test(rule(formStyle, ".cp-option-name")))
    check("the picker list is the tighter of the two menus", /padding: 4px;/.test(rule(formStyle, ".cp-menu.combo")) && /padding: 6px;/.test(rule(formStyle, ".cp-menu")))
    check("the menus take the elevated card under shadow-pop", /background: #fffefd;/.test(rule(formStyle, ".cp-menu")) && /box-shadow: 0 12px 40px #00000024;/.test(rule(formStyle, ".cp-menu")))
    check("the custom number is ruled off and 28 tall", /class="cp-menu-custom"/.test(form) && /border-top: 1px solid #f0ebe5;/.test(rule(formStyle, ".cp-menu-custom")) && /height: calc\(28px \* var\(--ui-font-scale, 1\)\);/.test(rule(formStyle, ".cp-in.tiny")))
    check("the three pickers show a 14px chevron", (form.match(/class="cp-caret"/g) ?? []).length === 2 && /width: 14px;/.test(rule(formStyle, ".cp-caret")))
    check("a model card is MiMo's own, on the elevated card inside --color-line", /background: #fffefd;/.test(rule(formStyle, ".cp-model")) && /border: 1px solid #f0ebe5;/.test(rule(formStyle, ".cp-model")))

    check("a tab and a chip are MiMo's txt ink with no fill when chosen", /color: var\(--text-body\);/.test(rule(modelsStyle, ".tab")) && !/background: var\(--surface-hover\);/.test(rule(modelsStyle, ".tab.on")) && !/background: var\(--surface-hover\);/.test(rule(modelsStyle, ".preset.on")))
    check("a provider mark in a tab or chip is 20 square on a 6px corner", /border-radius: 6px;/.test(rule(modelsStyle, ".tab :deep(.mark),\n.preset-mark")))
    check("MiMo's card is description-less: the endpoint hint and the key's line are gone", !/data-endpoint-hint/.test(form) && !/apiKey\.description/.test(form) && !/"model\.endpointHint"/.test(i18n) && !/"provider\.custom\.field\.apiKey\.description"/.test(i18n))
    check("请求头（可选）stays, because it is wired through", /provider\.custom\.headers\.label/.test(form))
  }

  // ------------------------------------------------------------------ F2-8
  section("Round 21 (F2-8): the page title's dark ink, the filled glyphs and MiMo's wording")
  {
    check("a page title takes --color-txt in dark", /:root\[data-theme="dark"\] h2 \{\s*color: #f4f4f5;/.test(style) && /:root\[data-theme="dark"\] h2 \{\s*color: #f4f4f5;/.test(modelsStyle))
    const glyphs = template.match(/<svg class="nav-ico"[^>]*>/g) ?? []
    check("all fifteen settings pages have filled navigation glyphs", glyphs.length === 15 && glyphs.every((tag) => /fill="currentColor"/.test(tag)), String(glyphs.length))
    check("none of them is a wire drawing any more", !/class="nav-ico"[^>]*fill="none"/.test(template))
    check("models.intro says where a key is kept, as MiMo's does", /"set\.models\.intro": "自定义模型使用你自己的密钥：填入各家的 API Key 即可在聊天里选用，仅保存到本地引擎配置"/.test(i18n))
    check("the remove confirmation is MiMo's sentence", /"set\.models\.removeProviderBody": "将删除「\{name\}」及其全部模型，且不可恢复。"/.test(i18n))
    check("the 名称 placeholder is MiMo's literal my-provider", /form\.providerId\.trim\(\) \|\| 'my-provider'/.test(form) && !/"provider\.custom\.field\.name\.placeholder"/.test(i18n))
  }
}
