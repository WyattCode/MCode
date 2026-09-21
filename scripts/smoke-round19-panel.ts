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
}
