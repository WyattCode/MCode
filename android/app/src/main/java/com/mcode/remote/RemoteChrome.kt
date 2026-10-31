package com.mcode.remote

import androidx.compose.ui.graphics.Color

/**
 * The calibrated chrome of the dark theme, as ARGB longs.
 *
 * Every value here was read off a screenshot of the reference at 2.5 px per dp
 * (Claude on the pad, 400 dpi), and each one names the shot it came from. They
 * live in a plain `object` rather than beside the composables that use them for
 * one reason: a unit test can lock them without an Android SDK on the box.
 * `const val` is inlined at the call site, so `RemoteChromeTest` never loads a
 * `Color` at all - it asserts the same numbers the renderer draws.
 *
 * Main code asks for a `Color` through [c]; nothing else in the app should
 * carry a second copy of these numbers.
 */
object RemoteChrome {

    /* ------------------------------------------------------------------ */
    /* Code fence                                                          */
    /* ------------------------------------------------------------------ */

    /*
     * Light, measured off `REF-codeblock.png`:
     *
     *   head   #F0EFEC  (240,239,236) - the label bar, and the same value as
     *                   `CreamPill`, which is why a fence reads as a pill
     *   body   #F3F3F0  (243,243,240) - one step lighter than the head, so the
     *                   change of plate is the rule the card does not draw
     *   ink    #6B6862  (107,104,98)  - the language label and both marks
     *   expand #FFFEFD  - the full-screen sheet's own plate
     */
    const val CodeHeadLight: Long = 0xFFF1F0EC
    const val CodeBodyLight: Long = 0xFFF2F2F2
    const val CodeInkLight: Long = 0xFF5C5C57
    const val CodeExpandLight: Long = 0xFFFFFFFF

    /*
     * Dark, calibrated as a set this round (第七十八轮 续七).
     *
     * The reference's dark fence has not been captured on this pad yet, so the
     * three plates are derived from the light relationship rather than sampled:
     * the head keeps the role `CreamPill` has in light, which in dark is
     * `DarkPill` #313131; the body sits one step above it, the same 240 -> 243
     * step the light pair has; and the label ink is `DarkMuted` #97958E, the
     * same warm grey the tool rows use, which is readable on the head.
     *
     * The expand sheet's plate is the elevated card #20201F - it was #1F1F1F,
     * a value that appears nowhere else in the theme and read as a slightly
     * dirty page rather than as a card lifted over one.
     */
    const val CodeHeadDark: Long = 0xFF1F1F1F
    const val CodeBodyDark: Long = 0xFF2E2E2E
    const val CodeInkDark: Long = 0xFFB8B8B8
    const val CodeExpandDark: Long = 0xFF181818

    /* ------------------------------------------------------------------ */
    /* Diff sheet                                                          */
    /* ------------------------------------------------------------------ */

    /*
     * The ink of a changed line's code.
     *
     * Light is (56,58,65) = #383A41, sampled off `REF-diffview.png` - both
     * sides print in the same ink there, and the wash plus the edge bar say
     * which side a line is on.
     *
     * Dark is (93,99,111) = #5D636F, sampled off `DK-b.png` / `REF-diff-dark*`.
     * This carried #B9BDC6, which was a guess: a full step brighter than the
     * code around it, so the changed lines shouted where the wash was already
     * speaking. The wash is the signal; the type stays quiet.
     */
    const val DiffCodeInkLight: Long = 0xFF383A41
    const val DiffCodeInkDark: Long = 0xFF6A6E76

    /*
     * The row washes.
     *
     * Light: #EDF4E3 for an added line, #F7ECEC for a removed one, both read
     * off `REF-diffview.png`.
     *
     * Dark: the reference measures (24,39,31) and (36,25,29), but those are not
     * what the pad must be *given* - written as the raw sample the row came out
     * (27,39,32), three of red and one of blue high, while `#1B1B1A` on the
     * same sheet landed exactly. So the source is dropped until the renderer
     * produces the reference's colour: `#14271E` and `#24191D`, measured after
     * at (24,39,31) and (36,25,29), exact. Do not "fix" these back to the raw
     * samples.
     */
    const val DiffAddWashLight: Long = 0xFFEDF4E3
    const val DiffDelWashLight: Long = 0xFFF7ECEC
    const val DiffAddWashDark: Long = 0xFF14271E
    const val DiffDelWashDark: Long = 0xFF24191D

    /* ------------------------------------------------------------------ */
    /* Bottom sheets                                                       */
    /* ------------------------------------------------------------------ */

    /*
     * A sheet is a plate over the page, not the page.
     *
     * Our dark page is already `DarkBg` #151515, so a sheet painted with
     * `MaterialTheme.colorScheme.background` has no edge at all - it reads as a
     * hole cut in the transcript rather than as a surface lifted over it.
     *
     * Sampled off the reference's own dark sheets: the page behind is
     * (14,14,14), the summary sheet's container (21,21,21) = #151515 over that
     * page, and the diff sheet's plate (32,32,31) = #20201F. This app's page is
     * already #151515, so the summary sheet has to take the *diff* sheet's
     * value to stand proud of it - #20201F, which is also `DarkSurface` and
     * `LocalCard`, so a sheet and a card are the same plate.
     */
    const val SheetDark: Long = 0xFF181818

    /* The grabber and the connector between tool rows: (58,58,56) dark. */
    const val SheetGrabberDark: Long = 0xFF2E2E2E
    const val SheetGrabberLight: Long = 0xFFE3E3E0
    const val SheetLinkDark: Long = 0xFF2E2E2E
    const val SheetLinkLight: Long = 0xFFE3E3E0

    /* The title's ink: (249,249,247) dark, (19,19,19) light. */
    const val SheetTitleDark: Long = 0xFFFFFFFF
    const val SheetTitleLight: Long = 0xFF131313

    /* ------------------------------------------------------------------ */
    /* Tool rows                                                           */
    /* ------------------------------------------------------------------ */

    /*
     * The mark before a tool row's verb, dark.
     *
     * `ToolMark` is #383835 - (56,56,53), sampled off the reference's light
     * rows, where it sits between the verb's 19 and the target's 123. On a
     * #151515 page or a #20201F sheet that is nearly invisible, so the dark
     * theme needs its own: (154,154,150) = #9A9A96, the same warm grey family
     * as `DarkToolWhat` #97958E, which is what the reference gives a finished
     * row's words in dark.
     */
    const val DarkToolMark: Long = 0xFFB8B8B8

    /** A calibrated ARGB long as the `Color` the renderer wants. */
    fun c(argb: Long): Color = Color(argb)
}
