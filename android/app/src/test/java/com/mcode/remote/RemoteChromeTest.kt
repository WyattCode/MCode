package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The dark chrome's calibrated numbers, locked so a later pass cannot quietly
 * drift them back to a guess.
 *
 * Every value here was read off a screenshot of the reference at 2.5 px per dp.
 * The constants are `const val`, so the compiler inlines them and this test
 * needs no Android SDK and no Compose runtime - the same shape as
 * `DiffNumberTest`, which is pure JVM JUnit.
 */
class RemoteChromeTest {

    @Test
    fun darkDiffCodeInkIsTheMeasuredGrey() {
        // (93,99,111) off `DK-b.png` / `REF-diff-dark*`: a changed line's code
        // in dark, one quiet step under the body ink.
        assertEquals(0xFF5D636FL, RemoteChrome.DiffCodeInkDark)
    }

    @Test
    fun darkDiffCodeInkIsNotTheOldBrightGrey() {
        // #B9BDC6 was a guess and read a full step brighter than the code
        // around it, so the changed lines shouted where the wash already spoke.
        assertNotEquals(0xFFB9BDC6L, RemoteChrome.DiffCodeInkDark)
    }

    @Test
    fun lightDiffCodeInkStaysTheMeasuredInk() {
        // (56,58,65) off `REF-diffview.png`; both sides print in it.
        assertEquals(0xFF383A41L, RemoteChrome.DiffCodeInkLight)
    }

    @Test
    fun darkCodeFenceIsTheCalibratedSet() {
        // Head keeps the role `CreamPill` has in light, which is `DarkPill`
        // #313131 in dark; the body sits one step above it; the label ink is
        // `DarkMuted`; the expand sheet is the elevated card.
        assertEquals(0xFF313131L, RemoteChrome.CodeHeadDark)
        assertEquals(0xFF3A3A38L, RemoteChrome.CodeBodyDark)
        assertEquals(0xFF97958EL, RemoteChrome.CodeInkDark)
        assertEquals(0xFF20201FL, RemoteChrome.CodeExpandDark)
    }

    @Test
    fun lightCodeFenceKeepsItsMeasuredSet() {
        // `REF-codeblock.png`: head 240,239,236; body 243,243,240; label
        // 107,104,98; the full-screen sheet on white.
        assertEquals(0xFFF0EFECL, RemoteChrome.CodeHeadLight)
        assertEquals(0xFFF3F3F0L, RemoteChrome.CodeBodyLight)
        assertEquals(0xFF6B6862L, RemoteChrome.CodeInkLight)
        assertEquals(0xFFFFFEFDL, RemoteChrome.CodeExpandLight)
    }

    @Test
    fun darkSummarySheetIsElevatedOverThePage() {
        // The reference's dark summary sheet is (21,21,21) over a (14,14,14)
        // page, and its diff sheet's plate is (32,32,31). Our page is already
        // #151515, so a sheet has to take the diff plate's value to stand proud
        // of it - otherwise it is the page and has no edge.
        assertEquals(0xFF20201FL, RemoteChrome.SheetDark)
        assertNotEquals(0xFF151515L, RemoteChrome.SheetDark)
    }

    @Test
    fun darkToolMarkIsLegibleOnTheDarkPage() {
        // (154,154,150): `ToolMark` #383835 is a light-theme value and all but
        // vanishes on #151515 / #20201F.
        assertEquals(0xFF9A9A96L, RemoteChrome.DarkToolMark)
    }

    @Test
    fun compensatedWashesAreUnchanged() {
        // The reference measures (24,39,31) and (36,25,29), but the pad draws
        // those from #14271E / #24191D. These are the compensated values and
        // must not be "fixed" back to the raw samples.
        assertEquals(0xFF14271EL, RemoteChrome.DiffAddWashDark)
        assertEquals(0xFF24191DL, RemoteChrome.DiffDelWashDark)
    }

    @Test
    fun lightWashesAreUnchanged() {
        assertEquals(0xFFEDF4E3L, RemoteChrome.DiffAddWashLight)
        assertEquals(0xFFF7ECECL, RemoteChrome.DiffDelWashLight)
    }

    @Test
    fun sheetGrabberAndLinkShareTheMeasuredGrey() {
        // (58,58,56) dark, (216,216,214) light - the grabber and the connector
        // between tool rows are the same hairline in the reference.
        assertEquals(0xFF3A3A38L, RemoteChrome.SheetGrabberDark)
        assertEquals(0xFF3A3A38L, RemoteChrome.SheetLinkDark)
        assertEquals(0xFFD8D8D6L, RemoteChrome.SheetGrabberLight)
        assertEquals(0xFFD8D8D6L, RemoteChrome.SheetLinkLight)
    }
}
