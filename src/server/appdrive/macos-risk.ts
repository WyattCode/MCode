import type { Step } from "./stepping"

const sensitiveApp = /telegram|whatsapp|wechat|weixin|微信|signal|messages|imessage|短信|discord|slack|teams|messenger|skype|飞书|lark|钉钉|dingtalk|qq|mail|outlook|thunderbird|邮件|邮箱|alipay|支付宝|paypal|wallet|钱包|支付|payment|bank|银行|terminal|iterm|warp|alacritty|kitty|wezterm|ghostty|终端|console/i
const destructiveText = /\b(?:rm|rmdir|sudo|del|erase|delete|remove|shred|unlink|wipe|format|truncate|drop)\b|删除|清空|抹掉|擦除|移除|销毁|格式化|清除/i

export function classifyMacOSAction(app: string, steps: readonly Step[]): ("sensitive-app" | "destructive-text")[] {
  const risks: ReturnType<typeof classifyMacOSAction> = []
  if (sensitiveApp.test(app.normalize("NFKC"))) risks.push("sensitive-app")
  if (steps.some((step) => step.action === "type" && destructiveText.test(String(step.text ?? "").normalize("NFKC")))) risks.push("destructive-text")
  return risks
}
