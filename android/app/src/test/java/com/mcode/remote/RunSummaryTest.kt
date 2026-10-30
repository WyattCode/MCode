package com.mcode.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The summary line over a run of calls.
 *
 * This is a piece of text, so it is easy to leave alone - but it is the only
 * thing the reader sees when a group of steps is folded, and it had drifted from
 * the desktop in four separate ways at once. The desktop's answer is fixed
 * somewhere else in this repository: `groupSummary` in `lib/step-rows.ts` builds
 * the buckets, `buildWorkDisplay.*` in `lib/i18n.ts` supplies the words. These
 * tests hold this file to that, so the two cannot drift again silently.
 *
 * Worth noting what "count" means here, because it is not the number of calls:
 * a bucket counts *distinct paths* for reads and edits, and calls for everything
 * else. Two reads of one file are one file read.
 */
class RunSummaryTest {

    private fun tool(name: String, path: String = "", uid: String = name) = Item.Tool(
        uid = uid,
        name = name,
        status = "completed",
        output = "",
        raw = JSONObject().apply {
            if (path.isNotBlank()) put("input", JSONObject().put("path", path))
        },
    )

    private fun summary(vararg tools: Item.Tool): String = runSummary(ToolRun(tools.toList(), "run.test"))

    /**
     * Searches are not reads.
     *
     * The old line counted `glob` and `grep` in with `read`, so this exact run -
     * one file opened, two patterns looked for - reported 「读取了 3 个文件」. The
     * desktop splits them and words the second bucket 「已搜索 N 次」.
     */
    @Test
    fun searchingIsNotReading() {
        assertEquals(
            "已读取 1 个文件 · 已搜索 2 次",
            summary(tool("read", "a.kt", "r1"), tool("glob", "**/*.kt", "g1"), tool("grep", "needle", "g2")),
        )
    }

    /** Two reads of the same path are one file. */
    @Test
    fun oneFileReadTwiceIsOneFile() {
        assertEquals("已读取 1 个文件", summary(tool("read", "a.kt", "r1"), tool("read", "a.kt", "r2")))
    }

    /** Two different files are two. */
    @Test
    fun twoFilesAreTwo() {
        assertEquals("已读取 2 个文件", summary(tool("read", "a.kt", "r1"), tool("read", "b.kt", "r2")))
    }

    /**
     * A command and a write are their own buckets, and the order is the order
     * they first appear - not a fixed ranking.
     */
    @Test
    fun bucketsFollowFirstAppearance() {
        assertEquals(
            "已运行 1 条命令 · 已编辑 1 个文件",
            summary(tool("bash", uid = "b1"), tool("write", "a.kt", "w1")),
        )
        assertEquals(
            "已编辑 1 个文件 · 已运行 1 条命令",
            summary(tool("write", "a.kt", "w1"), tool("bash", uid = "b1")),
        )
    }

    /**
     * An edit counted twice on one path is one file edited, and the same rule
     * that makes repeated reads collapse makes repeated edits collapse.
     */
    @Test
    fun oneFileEditedTwiceIsOneFile() {
        assertEquals("已编辑 1 个文件", summary(tool("edit", "a.kt", "e1"), tool("edit", "a.kt", "e2")))
    }

    /**
     * A call with no path still counts, as a call.
     *
     * A write whose input did not name a file cannot join the path set, and
     * dropping it would make the run look smaller than it was.
     */
    @Test
    fun aReadWithNoPathStillCounts() {
        assertEquals("已读取 1 个文件", summary(tool("read", uid = "r1")))
    }

    /** A notebook_edit is an edit, not a generic 操作. */
    @Test
    fun notebookEditIsAnEdit() {
        assertEquals("已编辑 1 个文件", summary(tool("notebook_edit", "nb.ipynb", "n1")))
    }

    /** Anything outside the four known buckets is an 操作. */
    @Test
    fun unknownToolsAreOperations() {
        assertEquals("已执行 2 个操作", summary(tool("task", uid = "t1"), tool("present_files", uid = "p1")))
    }

    /**
     * The failure count is not in the words.
     *
     * The desktop marks a failed group with an icon on the summary line, so
     * appending 「（N 个失败）」 here put a second and differently-worded signal on
     * the same row.
     */
    @Test
    fun failureIsNotSpelledOutInTheSummary() {
        val failed = Item.Tool(uid = "b1", name = "bash", status = "error", output = "")
        assertEquals("已运行 1 条命令", summary(failed))
    }

    /** Separator is the desktop's 「 · 」, not a comma. */
    @Test
    fun bucketsAreJoinedWithTheDesktopsSeparator() {
        val line = summary(tool("read", "a.kt", "r1"), tool("bash", uid = "b1"))
        assertEquals("已读取 1 个文件 · 已运行 1 条命令", line)
        assertEquals(false, line.contains(", "))
    }

    /** An empty run says nothing rather than 「已使用 0 个工具」. */
    @Test
    fun anEmptyRunHasNoSummary() {
        assertEquals("", summary())
    }
}