/**
 * Whether a message tells the model not to test or verify its work.
 *
 * "你不需要任何测试，只靠你自己完成" was ignored by a model that then opened the
 * page, took screenshots, evaluated scripts and solved the geometry in node for
 * twenty steps. Said once in the user's words it is not enough, so the turn that
 * carries it is also told so as a note, and the browser and desktop tool is not
 * available to it.
 *
 * Narrow on purpose: "don't forget to test" and "不要忘记测试" are the opposite
 * request, and "不要测试环境的数据" is about something else.
 */
const CHINESE = /[不无别勿](?:需要|需|要|用|必)?(?:再)?(?:去|做|进行|执行)?(?:任何|一切)?(?:的)?(?:测试|验证|检验|试运行|截图)(?!环境|服务器|数据|账号|账户|用例|集|文件|码)/u
const ENGLISH = /\b(?:no|without|skip)\s+(?:any\s+)?(?:testing|tests|verification|screenshots?)\b|\b(?:do not|don't|dont|never|no need to|need not|needn't)\s+(?:(?:run|do|perform|need to|any)\s+)*(?:test|tests|testing|verify|verification|screenshot)/i

export function forbidsTesting(text: string): boolean {
  return CHINESE.test(text) || ENGLISH.test(text)
}

/** The note the turn carries, written to the model. */
export const NO_TESTING_NOTE =
  "The user asked you not to test or verify this work. Do not open the result in a browser or app, take screenshots, evaluate scripts against it or write throwaway scripts to check it; write it carefully, finish, and say where the file is. The app tool is not available for this message."

/** What a call to the app tool is answered with while that note is in force. */
export const NO_TESTING_REFUSAL =
  "The user said not to test or verify this work, so controlling a browser or an app (opening it, screenshots, eval) is not available for this message. Finish from what you wrote and tell the user where the result is."
