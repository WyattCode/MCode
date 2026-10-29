package com.mcode.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The 联网搜索 switch's reading and writing rules.
 *
 * The reason this is worth pinning: `websearch` is not a boolean field. It is
 * `"auto"`, a provider id, or `false`, and the obvious reader -
 * `JSONObject.optBoolean("websearch")` - calls `"auto"` false. That would show
 * the switch off on a machine where search is on, and the first tap would then
 * write `"auto"` over a provider the reader had chosen. These tests say what
 * the helper actually does, including the string `"false"` case, which is *not*
 * the boolean and therefore does not turn search off.
 */
class WebSearchSettingTest {

    private fun config(vararg pairs: Pair<String, Any?>): JSONObject {
        val obj = JSONObject()
        for ((k, v) in pairs) obj.put(k, v)
        return obj
    }

    /** No config at all: nothing has said false, so it is on. */
    @Test
    fun aMissingConfigCountsAsOn() {
        assertTrue(WebSearchSetting.enabled(null))
    }

    /** A config without the key: same as above. */
    @Test
    fun aMissingKeyCountsAsOn() {
        assertTrue(WebSearchSetting.enabled(JSONObject()))
    }

    /** The one value that turns it off. */
    @Test
    fun anExplicitBooleanFalseIsOff() {
        assertFalse(WebSearchSetting.enabled(config("websearch" to false)))
    }

    /** `"auto"` is the on state the switch writes. */
    @Test
    fun autoIsOn() {
        assertTrue(WebSearchSetting.enabled(config("websearch" to "auto")))
    }

    /** A chosen provider is on too - the switch must not clobber it. */
    @Test
    fun aProviderIdIsOn() {
        assertTrue(WebSearchSetting.enabled(config("websearch" to "exa")))
    }

    /**
     * The string `"false"` is not the boolean `false`.
     *
     * Only the boolean disables. Documented here because it is the case a
     * reader is most likely to get wrong when reaching for `optBoolean`.
     */
    @Test
    fun theStringFalseDoesNotDisable() {
        assertTrue(WebSearchSetting.enabled(config("websearch" to "false")))
    }

    /** Turning on writes the string `"auto"`, not a boolean. */
    @Test
    fun patchOnWritesAuto() {
        val body = WebSearchSetting.patch(true)
        assertEquals("auto", body.get("websearch"))
        assertTrue(body.get("websearch") is String)
    }

    /** Turning off writes the boolean `false`, not the string `"false"`. */
    @Test
    fun patchOffWritesBooleanFalse() {
        val body = WebSearchSetting.patch(false)
        assertEquals(false, body.get("websearch"))
        assertTrue(body.get("websearch") is Boolean)
    }

    /** enabled -> patch -> re-read round-trips in both directions. */
    @Test
    fun togglingRoundTrips() {
        val on = WebSearchSetting.patch(true)
        assertTrue(WebSearchSetting.enabled(on))

        val off = WebSearchSetting.patch(false)
        assertFalse(WebSearchSetting.enabled(off))

        assertTrue(WebSearchSetting.enabled(WebSearchSetting.patch(true)))
    }
}
