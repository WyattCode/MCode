package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a reply parses into.
 *
 * The transcript that prompted this is a real one, taken off the pad: a heading,
 * two bullets, a nested bullet, an ordered list, a quote, a table, a link and a
 * rule, in that order. Every one of those is a different `MdBlock`, and getting
 * the dispatch wrong is invisible until someone reads a reply where a table
 * renders as pipe-delimited text.
 *
 * These are answerable without a device, which is why they are here: the pad has
 * been off adb for most of a night and the parser is still worth checking.
 *
 * Note to self: the block *count* is not worth asserting from the source at a
 * glance. Written as seven first, the parse produced eight - the bare `[链接]`
 * line is its own paragraph, which is right and which I had merged into the
 * rule by eye. The assertions below check each block's type in order instead.
 */
class MarkdownBlocksTest {

    private val sample = """
        ## 列表测试
        - 第一项
        - 第二项 with **bold** and _italic_
          - 嵌套项
        1. 有序一
        2. 有序二

        > 这是一段引用文字

        | 列A | 列B |
        | --- | --- |
        | 1 | 2 |

        [链接](https://example.com)

        ---

        结束
    """.trimIndent()

    @Test
    fun theRealTranscriptSplitsInOrder() {
        val blocks = Md.blocks(sample)
        assertEquals(
            "the eight kinds in order",
            listOf(
                MdBlock.Heading::class.java,
                MdBlock.ListBlock::class.java,
                MdBlock.ListBlock::class.java,
                MdBlock.Quote::class.java,
                MdBlock.Table::class.java,
                MdBlock.Para::class.java,
                MdBlock.Rule::class.java,
                MdBlock.Para::class.java,
            ),
            blocks.map { it::class.java },
        )
    }

    @Test
    fun theHeadingKeepsItsLevelAndText() {
        val head = Md.blocks(sample)[0] as MdBlock.Heading
        assertEquals(2, head.level)
        assertEquals("列表测试", head.text)
    }

    /** The two lists are separate blocks, not one run: the ordered one starts at 1. */
    @Test
    fun bulletsAndNumbersAreDifferentLists() {
        val blocks = Md.blocks(sample)
        val bullet = blocks[1] as MdBlock.ListBlock
        val numbered = blocks[2] as MdBlock.ListBlock
        assertEquals(false, bullet.ordered)
        assertEquals(3, bullet.items.size)
        assertEquals(true, numbered.ordered)
        assertEquals(2, numbered.items.size)
        assertEquals(1, numbered.start)
    }

    /**
     * A nested bullet is depth 1, and its text does not keep the indent.
     *
     * This is the pair the indentation is drawn from - `padding(start = depth *
     * 20.4)` - so a depth that came out 0 for a nested item would put it flush
     * with the bullet above it.
     */
    @Test
    fun theNestedBulletIsDepthOne() {
        val bullets = (Md.blocks(sample)[1] as MdBlock.ListBlock).items
        assertEquals(0, bullets[0].depth)
        assertEquals(0, bullets[1].depth)
        assertEquals(1, bullets[2].depth)
        assertEquals("嵌套项", bullets[2].text)
        // the bold/italic markers are gone from the second item's text
        assertTrue(bullets[1].text.startsWith("第二项 with"))
    }

    @Test
    fun theTableKeepsItsCells() {
        val table = Md.blocks(sample)[4] as MdBlock.Table
        assertEquals(listOf("列A", "列B"), table.head)
        assertEquals(1, table.rows.size)
        assertEquals(listOf("1", "2"), table.rows[0])
    }

    @Test
    fun theQuoteHoldsItsOwnParagraph() {
        val quote = Md.blocks(sample)[3] as MdBlock.Quote
        val inner = quote.blocks.filterIsInstance<MdBlock.Para>()
        assertEquals(1, inner.size)
        assertEquals("这是一段引用文字", inner[0].text)
    }

    /** The bare link line is a paragraph of its own, between the table and the rule. */
    @Test
    fun theLinkLineIsItsOwnParagraph() {
        val p = Md.blocks(sample)[5] as MdBlock.Para
        assertTrue(p.text.contains("链接"))
    }

    /**
     * A fence keeps its language, and its body is verbatim.
     *
     * The body must not go through the inline pass: a code block containing
     * `**` is a code block containing two asterisks.
     */
    @Test
    fun aFencedBlockKeepsItsLanguageAndItsBody() {
        val src = "before\n\n" + "```kotlin\nval x = **not bold**\n```\n" + "\nafter"
        val code = Md.blocks(src).filterIsInstance<MdBlock.Code>().single()
        assertEquals("kotlin", code.lang)
        assertEquals("val x = **not bold**", code.code.trim())
    }

    /** An unclosed fence still becomes a code block rather than swallowing the reply as prose. */
    @Test
    fun anUnclosedFenceIsStillCode() {
        val src = "```\nline one\nline two"
        val blocks = Md.blocks(src)
        assertTrue(blocks.filterIsInstance<MdBlock.Code>().isNotEmpty())
    }
}
