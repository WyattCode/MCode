/**
 * Round 19, lane B: the right panel and two side-column details, moved to
 * MiMo 26.920 (RP-1 onwards, R19-SH2, R19-SH3).
 *
 * What can run here runs against the real code - the panel's width rule, the
 * glow's reducer, the conversation card's lines, the i18n tables. The rest
 * lives in markup and is read from the source; the behaviour behind it is
 * measured in a real window by the lane's Electron probes, whose numbers are
 * in the report. smoke.ts calls `roundNineteenPanelChecks` with its own check
 * and section.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { LANGUAGES, language, t } from "../src/renderer/src/lib/i18n"
import { PANEL_MIN_WIDTH } from "../src/renderer/src/stores/right-panel"
import { panelWidthShown } from "../src/renderer/src/lib/right-tools"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundNineteenPanelChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 19 (lane B): RP-7 the launcher's cards carry MiMo's own short descriptions")
  {
    const before = language.value
    const mimo: Record<string, string[]> = {
      "zh-CN": ["查看工作区改动", "浏览项目文件", "发起侧边对话", "打开网站", "启动交互式 shell"],
      "zh-TW": ["檢視工作區變更", "瀏覽專案檔案", "開始一個側邊對話", "開啟一個網站", "啟動一個互動式殼層"],
      en: ["View workspace changes", "Browse project files", "Start a side conversation", "Open a website", "Launch an interactive shell"],
      ko: ["작업 공간 변경 사항 보기", "프로젝트 파일 탐색", "사이드 대화 시작", "웹사이트 열기", "대화형 셸 실행"],
      ja: ["ワークスペースの変更を表示", "プロジェクトファイルを閲覧", "サイド会話を開始", "ウェブサイトを開く", "対話型シェルを起動"],
      de: ["Änderungen im Arbeitsbereich anzeigen", "Projektdateien durchsuchen", "Eine Nebenunterhaltung starten", "Eine Website öffnen", "Eine interaktive Shell starten"],
      fr: ["Voir les modifications de l'espace de travail", "Parcourir les fichiers du projet", "Démarrer une conversation latérale", "Ouvrir un site web", "Lancer un shell interactif"],
    }
    const tools = ["review", "files", "chat", "browser", "terminal"]
    for (const [id, lines] of Object.entries(mimo)) {
      language.value = id as typeof language.value
      const shown = tools.map((tool) => t(`launch.${tool}Desc`))
      check(`RP-7: the ${id} launcher reads as MiMo's`, shown.join("|") === lines.join("|"), shown)
    }
    // The four tables MiMo does not ship follow the same short style, none keeps round 16's sentence.
    const english = mimo.en!
    const own: string[] = []
    for (const { id } of LANGUAGES) {
      if (id in mimo) continue
      language.value = id
      for (const tool of tools) {
        const line = t(`launch.${tool}Desc`)
        if (english.includes(line) || line.split(" ").length > 6) own.push(`${id}:${line}`)
      }
    }
    check("RP-7: the other tables carry short lines of their own", own.length === 0, own)
    language.value = before
  }

  section("Round 19 (lane B): RP-8 a middle click closes a tab on release, as MiMo's auxclick does")
  {
    const panel = await read("src/renderer/src/components/RightPanel.vue")
    const down = /function onTabMouseDown\([^)]*\) \{([\s\S]*?)\n\}/.exec(panel)?.[1] ?? ""
    const aux = /function onTabAuxClick\([^)]*\) \{([\s\S]*?)\n\}/.exec(panel)?.[1] ?? ""
    check("RP-8: the press only keeps the page from autoscrolling", down.includes("preventDefault") && !down.includes("requestClose"), down)
    check("RP-8: the release closes the tab, middle button only", /event\.button !== 1/.test(aux) && aux.includes("requestClose([id])"), aux)
    check("RP-8: each tab listens for the release", /@auxclick="onTabAuxClick\(\$event, tab\.id\)"/.test(panel))
  }

  section("Round 19 (lane B): RP-3 a folded side column leaves no rail for the panel to allow for")
  {
    check("RP-3: folded, a 1000px window lets the panel reach 520, as MiMo's", panelWidthShown(900, 1000, 0, PANEL_MIN_WIDTH, 0) === 520, panelWidthShown(900, 1000, 0, PANEL_MIN_WIDTH, 0))
    check("RP-3: and a stored 500 is drawn at 500", panelWidthShown(500, 1000, 0, PANEL_MIN_WIDTH, 0) === 500)
    check("RP-3: with the column open the rail still counts", panelWidthShown(900, 1000, 0, PANEL_MIN_WIDTH) === 458)
    const panel = await read("src/renderer/src/components/RightPanel.vue")
    check("RP-3: the panel's rail follows the fold", /const rail = computed\(\(\) => \(props\.sideCollapsed \? 0 : RAIL_WIDTH\)\)/.test(panel))
    check("RP-3: the drag's max and the shown width both use it", /const maxWidth = computed\(\(\) => Math\.max\(PANEL_MIN_WIDTH, viewport\.value - rail\.value -/.test(panel) && /panelWidthShown\([^)]*rail\.value\)/.test(panel))
  }

  section("Round 19 (lane B): RP-5 a picture in the files tab zooms into the preview out of itself")
  {
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    const img = /<img\s[^>]*class="fv-img"[^>]*>/.exec(files)?.[0] ?? ""
    const handler = /function previewImage\(event: Event\) \{([\s\S]*?)\n\}/.exec(files)?.[1] ?? ""
    check("RP-5: a click and Enter or Space both open it through the one handler", /@click="previewImage\(\$event\)"/.test(img) && /@keydown\.enter\.space\.prevent="previewImage\(\$event\)"/.test(img), img)
    check("RP-5: and the handler hands the preview the picture's rect", /rect = \(event\.currentTarget as HTMLElement\)\.getBoundingClientRect\(\)/.test(handler) && /openImagePreview\(mediaUrl\.value, \{[^}]*\brect \}\)/.test(handler), handler)
  }

  section("Round 19 (lane B): RP-6 folding the file tree hides it, so it keeps its scroll")
  {
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    check("RP-6: the tree stays in the page while folded", /<aside v-show="treeOpen" class="fv-tree"/.test(files) && !/v-if="treeOpen"/.test(files))
  }
}
