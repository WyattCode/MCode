package com.mcode.remote

import org.json.JSONObject

/**
 * The 联网搜索 switch, read and written the way the desktop does it.
 *
 * Mirrors `SettingsDialog.vue`'s `data-websearch-switch`: the setting is on
 * unless it is *explicitly* false. `config.websearch` is not a boolean field -
 * it is `"auto"`, a provider id, or `false` - so `optBoolean` is the wrong
 * reader (it would call `"auto"` false). Turning it on writes `"auto"`;
 * turning it off writes the boolean `false`, never the string `"false"`.
 */
object WebSearchSetting {

    /** Desktop rule: on unless explicitly false. */
    fun enabled(config: JSONObject?): Boolean {
        val value = config?.opt("websearch") ?: return true
        if (value == JSONObject.NULL) return true
        return !(value is Boolean && !value)
    }

    /** Patch body for config.set - on -> `"auto"`, off -> boolean `false`. */
    fun patch(enabled: Boolean): JSONObject {
        val body = JSONObject()
        if (enabled) body.put("websearch", "auto") else body.put("websearch", false)
        return body
    }
}
