package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The chrome's numbers, locked so a later pass cannot quietly drift them.
 *
 * These used to hold values sampled off Claude's screenshots, and the palette it
 * produced was warm: every one had red above blue, from +2 in the page to +12 in
 * the rule. That is cream paper, and it read as a copy because it was one.
 *
 * The mark is a black M in brushed silver on white and it has no hue at all -
 * sampled across the icon every pixel satisfies R == G == B. So the palette is a
 * neutral ladder now, and these tests hold it that way: the numbers below are
 * ours, and the neutrality check at the bottom is the one that matters most,
 * because a warm value creeping back in is exactly how the last theme drifted.
 *
 * The constants are `const val`, so the compiler inlines them and this test
 * needs no Android SDK and no Compose runtime - pure JVM JUnit.
 */
class RemoteChromeTest {

    @Test
    fun darkDiffCodeInkStaysQuietUnderTheBody() {
        // A changed line's code in dark: one quiet step under the body ink, so
        // the wash says which side a line is on and the type does not repeat it.
        assertEquals(0xFF6A6E76L, RemoteChrome.DiffCodeInkDark)
        assertNotEquals(0xFFB9BDC6L, RemoteChrome.DiffCodeInkDark)
    }

    @Test
    fun lightDiffCodeInkStaysTheMeasuredInk() {
        // (56,58,65); both sides print in it.
        assertEquals(0xFF383A41L, RemoteChrome.DiffCodeInkLight)
    }

    @Test
    fun darkCodeFenceIsTheNeutralSet() {
        // The head is the pill's own value, the body one step above it, the
        // label ink the muted ink, and the expand sheet the card.
        assertEquals(0xFF242424L, RemoteChrome.CodeHeadDark)
        assertEquals(0xFF2A2A2AL, RemoteChrome.CodeBodyDark)
        assertEquals(0xFF8A8A8AL, RemoteChrome.CodeInkDark)
        assertEquals(0xFF1A1A1AL, RemoteChrome.CodeExpandDark)
    }

    @Test
    fun lightCodeFenceIsTheNeutralSet() {
        assertEquals(0xFFF0F0F0L, RemoteChrome.CodeHeadLight)
        assertEquals(0xFFF5F5F5L, RemoteChrome.CodeBodyLight)
        assertEquals(0xFF7A7A7AL, RemoteChrome.CodeInkLight)
        assertEquals(0xFFFFFFFFL, RemoteChrome.CodeExpandLight)
    }

    @Test
    fun darkSummarySheetIsElevatedOverThePage() {
        // The page is #0D0D0D; a sheet has to sit above it or it has no edge.
        assertEquals(0xFF1A1A1AL, RemoteChrome.SheetDark)
        assertNotEquals(0xFF0D0D0DL, RemoteChrome.SheetDark)
    }

    @Test
    fun darkToolMarkIsLegibleOnTheDarkPage() {
        // #383835 is a light-theme value and all but vanishes on #0D0D0D.
        assertEquals(0xFF8A8A8AL, RemoteChrome.DarkToolMark)
    }

    @Test
    fun compensatedWashesAreUnchanged() {
        // Diff washes are functional colour - green added, red removed - so they
        // keep their hues. These are the compensated values that render as the
        // intended wash on this panel; do not "fix" them back to the raw samples.
        assertEquals(0xFF14271EL, RemoteChrome.DiffAddWashDark)
        assertEquals(0xFF24191DL, RemoteChrome.DiffDelWashDark)
    }

    @Test
    fun lightWashesAreUnchanged() {
        assertEquals(0xFFEDF4E3L, RemoteChrome.DiffAddWashLight)
        assertEquals(0xFFF7ECECL, RemoteChrome.DiffDelWashLight)
    }

    @Test
    fun sheetGrabberAndLinkShareTheHairline() {
        assertEquals(0xFF2A2A2AL, RemoteChrome.SheetGrabberDark)
        assertEquals(0xFF2A2A2AL, RemoteChrome.SheetLinkDark)
        assertEquals(0xFFD4D4D4L, RemoteChrome.SheetGrabberLight)
        assertEquals(0xFFD4D4D4L, RemoteChrome.SheetLinkLight)
    }

    /**
     * The palette is neutral, and this is what keeps it that way.
     *
     * A warm theme does not arrive all at once - it arrives one value at a time,
     * each one justified by the screenshot it was read from, until the page is
     * cream and nobody remembers choosing it. Every chrome value must therefore
     * satisfy |R - B| <= 2, which is the tolerance of an anti-aliased sample and
     * nothing more.
     *
     * The diff washes are exempt and deliberately so: they encode added and
     * removed, and a neutral green is not a green.
     */
    @Test
    fun everyChromeValueIsNeutral() {
        val chrome = mapOf(
            "CodeHeadLight" to RemoteChrome.CodeHeadLight,
            "CodeBodyLight" to RemoteChrome.CodeBodyLight,
            "CodeInkLight" to RemoteChrome.CodeInkLight,
            "CodeHeadDark" to RemoteChrome.CodeHeadDark,
            "CodeBodyDark" to RemoteChrome.CodeBodyDark,
            "CodeInkDark" to RemoteChrome.CodeInkDark,
            "CodeExpandDark" to RemoteChrome.CodeExpandDark,
            "SheetDark" to RemoteChrome.SheetDark,
            "SheetGrabberDark" to RemoteChrome.SheetGrabberDark,
            "SheetGrabberLight" to RemoteChrome.SheetGrabberLight,
            "SheetLinkDark" to RemoteChrome.SheetLinkDark,
            "SheetLinkLight" to RemoteChrome.SheetLinkLight,
            "SheetTitleDark" to RemoteChrome.SheetTitleDark,
            "SheetTitleLight" to RemoteChrome.SheetTitleLight,
            "DarkToolMark" to RemoteChrome.DarkToolMark,
        )
        for ((name, argb) in chrome) {
            val r = ((argb shr 16) and 0xFF).toInt()
            val b = (argb and 0xFF).toInt()
            assertTrue(
                "$name is not neutral: R=$r B=$b, off by ${r - b}",
                kotlin.math.abs(r - b) <= 2,
            )
        }
    }
}