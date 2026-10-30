package com.mcode.remote

/**
 * The thinking each assistant turn produced, kept apart from the reply.
 *
 * The cockpit accumulates reasoning in `deltas` and draws it in a fold; the
 * phone used to count it and throw the text away. This holds the text so the
 * fold can show it, keyed by message and part, in arrival order.
 *
 * Pure JVM on purpose: no Compose, no Android framework, so the unit tests run
 * without an SDK. It never touches the reply text - `partTexts` in MainActivity
 * is the only store the reply is rebuilt from.
 */
class ReasoningParts {
    /** `messageId|partId` -> the part's text so far. */
    private val texts = HashMap<String, String>()

    /** `messageId|partId` -> the order the part was first seen. */
    private val order = HashMap<String, Int>()

    /** partId -> its kind, so a delta knows whether its words are reasoning. */
    private val kinds = HashMap<String, String>()

    private var seq = 0

    private fun key(messageId: String, partId: String): String =
        messageId + "|" + partId.ifBlank { "__solo" }

    /** Forget everything - a session switch starts from a clean page. */
    fun clear() {
        texts.clear()
        order.clear()
        kinds.clear()
        seq = 0
    }

    /** Remember what kind of part an id names, before its deltas arrive. */
    fun rememberKind(partId: String, type: String) {
        if (partId.isBlank()) return
        kinds[partId] = type
    }

    /** The kind last remembered for a part, or "" if it was never announced. */
    fun kindOf(partId: String): String = kinds[partId] ?: ""

    /**
     * A whole-part snapshot.
     *
     * Kept only when it is at least as long as what is held: `message.updated`
     * arrives as soon as a part is announced, when its text is still "", and
     * letting that empty string overwrite fragments already applied stalled the
     * reply in the cockpit. The same rule applies here.
     */
    fun putSnapshot(messageId: String, partId: String, text: String) {
        if (messageId.isBlank()) return
        val k = key(messageId, partId)
        val held = texts[k] ?: ""
        if (text.length >= held.length) texts[k] = text
        if (k !in order) order[k] = seq++
    }

    /** A streamed fragment, appended to whatever the part already holds. */
    fun appendDelta(messageId: String, partId: String, fragment: String) {
        if (messageId.isBlank() || fragment.isEmpty()) return
        val k = key(messageId, partId)
        texts[k] = (texts[k] ?: "") + fragment
        if (k !in order) order[k] = seq++
    }

    /**
     * Every reasoning part for a message, in arrival order, joined the way the
     * cockpit joins them. Blank parts are skipped, so an announced-but-empty
     * part never leaves a gap.
     */
    fun joined(messageId: String): String {
        if (messageId.isBlank()) return ""
        val prefix = messageId + "|"
        return texts.entries
            .filter { it.key.startsWith(prefix) }
            .sortedBy { order[it.key] ?: Int.MAX_VALUE }
            .map { it.value }
            .filter { it.isNotBlank() }
            .joinToString("\n\n")
    }

    /** The length of [joined] - what `thinkOnly` and the fold both read. */
    fun charCount(messageId: String): Int = joined(messageId).length
}
