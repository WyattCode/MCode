package com.mcode.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The chrome's numbers, locked to the desktop's tokens.
 *
 * These held Claude's values once, sampled off screenshots of a different app,
 * and they made the pad a different product from the PC. The desktop runs MiMo's
 * token set (`src/renderer/src/styles/tokens.css`), so these are that file's
 * values under this app's names - the same page, the same ink, the same ladder.
 *
 * The point of locking them is not that these numbers are sacred. It is that
 * both halves of one product have to agree, and the only way that stays true
 * across a rename or a "quick fix" is a test that fails when one side drifts.
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
    fun darkCodeFenceIsTheDesktopLadder() {
        // Head is the pill (--surface-raised-hover), body the line
        // (--border-weak), label ink the body text (--text-base), expand sheet
        // the raised surface (--surface-raised).
        assertEquals(0xFF1F1F1FL, RemoteChrome.CodeHeadDark)
        assertEquals(0xFF2E2E2EL, RemoteChrome.CodeBodyDark)
        assertEquals(0xFFB8B8B8L, RemoteChrome.CodeInkDark)
        assertEquals(0xFF181818L, RemoteChrome.CodeExpandDark)
    }

    @Test
    fun lightCodeFenceIsTheDesktopLadder() {
        // --surface-hover, --surface-layer, --icon-base, --surface-raised.
        assertEquals(0xFFF1F0ECL, RemoteChrome.CodeHeadLight)
        assertEquals(0xFFF2F2F2L, RemoteChrome.CodeBodyLight)
        assertEquals(0xFF5C5C57L, RemoteChrome.CodeInkLight)
        assertEquals(0xFFFFFFFFL, RemoteChrome.CodeExpandLight)
    }

    @Test
    fun darkSummarySheetIsElevatedOverThePage() {
        // The page is --surface-base #141414; the sheet is --surface-raised
        // #181818. Four steps, which is what puts an edge on it.
        assertEquals(0xFF181818L, RemoteChrome.SheetDark)
        assertNotEquals(0xFF141414L, RemoteChrome.SheetDark)
    }

    @Test
    fun darkToolMarkIsLegibleOnTheDarkPage() {
        // --text-base; the light-theme mark (#383835) vanishes on #141414.
        assertEquals(0xFFB8B8B8L, RemoteChrome.DarkToolMark)
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
        // --border-weak in dark, --border-button in light: the grabber and the
        // connector between tool rows are the same hairline.
        assertEquals(0xFF2E2E2EL, RemoteChrome.SheetGrabberDark)
        assertEquals(0xFF2E2E2EL, RemoteChrome.SheetLinkDark)
        assertEquals(0xFFE3E3E0L, RemoteChrome.SheetGrabberLight)
        assertEquals(0xFFE3E3E0L, RemoteChrome.SheetLinkLight)
    }

    /**
     * A title is read, so it is the strongest ink the scheme has.
     *
     * `--text-strong` is #151c13 in light and #ffffff in dark. Anything less on
     * a sheet is a title that looks like a label.
     */
    @Test
    fun sheetTitleIsTheStrongestInk() {
        assertEquals(0xFF131313L, RemoteChrome.SheetTitleLight)
        assertEquals(0xFFFFFFFFL, RemoteChrome.SheetTitleDark)
    }
}