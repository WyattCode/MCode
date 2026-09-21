import { CustomCommandExecutionError, createUniver, LocaleType, LogLevel, mergeLocales } from "@univerjs/presets"
import { UniverSheetsCorePreset } from "@univerjs/presets/preset-sheets-core"
import sheetsCoreZhCN from "@univerjs/presets/preset-sheets-core/locales/zh-CN"
import { UniverSheetsConditionalFormattingPreset } from "@univerjs/presets/preset-sheets-conditional-formatting"
import sheetsCfZhCN from "@univerjs/presets/preset-sheets-conditional-formatting/locales/zh-CN"
import { INotificationService } from "@univerjs/ui"
import "@univerjs/presets/lib/styles/preset-sheets-core.css"
import "@univerjs/presets/lib/styles/preset-sheets-conditional-formatting.css"

/*
 * MiMo's sheet engine: Univer with the sheets core and conditional formats,
 * always in Chinese and light, with no header bar, toolbar, formula bar or
 * context menu, only the sheet tabs at the foot - and Univer's own
 * notifications silenced, so the viewer's toasts are the only ones.
 */

const quiet = { show: () => ({ dispose: () => undefined }) }

export { CustomCommandExecutionError }

export function createSheetUniver(container: HTMLElement) {
  return createUniver({
    logLevel: LogLevel.WARN,
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: mergeLocales(sheetsCoreZhCN, sheetsCfZhCN) },
    presets: [
      UniverSheetsCorePreset({
        container,
        header: false,
        toolbar: false,
        formulaBar: false,
        contextMenu: false,
        footer: { sheetBar: true, statisticBar: false, zoomSlider: false, menus: false },
      }),
      UniverSheetsConditionalFormattingPreset(),
    ],
    override: [[INotificationService, { useValue: quiet }]],
  })
}
