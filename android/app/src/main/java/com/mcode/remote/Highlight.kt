package com.mcode.remote

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight

/**
 * Syntax colouring for a fenced block, in Claude's own palette.
 *
 * Every colour here was read off the reference's Python block on the pad, one
 * character at a time at 2.5 px per dp. It is not a theme borrowed from an
 * editor: the same reply on the pad gives
 *
 *   for  i  in  range(1, 4):          keyword #99329F, name #383A41,
 *                                     builtin #B8872D, literal #916A22
 *   print(f"Line {i}")                call #B8872D, string #659F58,
 *                                     interpolation #D36050
 *   print("Done")                     string #659F58
 *
 * A monochrome block was the last thing on this pane that plainly was not the
 * reference's: every other card had been measured, and code - the one block a
 * reader scans rather than reads - arrived in a single grey.
 */
object Highlight {

    /**
     * The six inks, light and dark.
     *
     * The dark set is not measured: the reference on this pad is in light mode
     * and its dark palette is not observable from here. These are derived from
     * the light values by holding hue and lifting lightness, so a dark block
     * keeps the same reading order - keyword loudest, punctuation quietest -
     * without claiming to be sampled.
     */
    data class Ink(
        val keyword: Color,
        val call: Color,
        val string: Color,
        val number: Color,
        val interpolation: Color,
        val plain: Color,
        val comment: Color,
    )

    val light = Ink(
        keyword = Color(0xFF99329F),
        call = Color(0xFFB8872D),
        string = Color(0xFF659F58),
        number = Color(0xFF916A22),
        interpolation = Color(0xFFD36050),
        plain = Color(0xFF383A41),
        comment = Color(0xFF8A8880),
    )

    val dark = Ink(
        keyword = Color(0xFFD9A0DE),
        call = Color(0xFFE0BE6A),
        string = Color(0xFF9FCF8E),
        number = Color(0xFFD6B055),
        interpolation = Color(0xFFF09080),
        plain = Color(0xFFCFCDC6),
        comment = Color(0xFF7C7A74),
    )

    /*
     * Keyword sets, by family.
     *
     * Split rather than pooled because `in` is a Python and Kotlin keyword but
     * an ordinary word in shell, and `do` is the reverse - colouring every
     * language's list everywhere would light up identifiers that the reference
     * leaves plain. A language outside all three falls back to the C-like set,
     * whose `if`/`for`/`return` are the words a reader of any block recognises.
     */
    private val python = setOf(
        "and", "as", "assert", "async", "await", "break", "class", "continue",
        "def", "del", "elif", "else", "except", "finally", "for", "from",
        "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
        "pass", "raise", "return", "try", "while", "with", "yield",
        "True", "False", "None", "self", "cls",
    )

    private val clike = setOf(
        "abstract", "as", "break", "case", "catch", "class", "const",
        "continue", "default", "do", "else", "enum", "extends", "final",
        "finally", "for", "fun", "function", "if", "implements", "import",
        "in", "instanceof", "interface", "let", "new", "package", "private",
        "protected", "public", "return", "static", "super", "switch", "this",
        "throw", "throws", "try", "typeof", "val", "var", "void", "while",
        "yield", "true", "false", "null", "undefined", "object", "override",
        "data", "sealed", "object", "when", "is", "await", "async",
    )

    private val shell = setOf(
        "case", "do", "done", "elif", "else", "esac", "fi", "for", "function",
        "if", "in", "select", "then", "until", "while", "export", "local",
        "return",
    )

    private val json_like = setOf("true", "false", "null")

    private fun keywordsFor(lang: String): Set<String> = when (lang.lowercase()) {
        "py", "python", "py3" -> python
        "sh", "bash", "zsh", "shell", "console", "shell-session" -> shell
        "json", "jsonc" -> json_like
        "kt", "kotlin", "java", "ts", "typescript", "tsx", "js", "javascript",
        "jsx", "c", "cpp", "c++", "cs", "csharp", "go", "rs", "rust", "swift",
        "scala", "dart", "php",
        -> clike
        else -> clike
    }

    /** Whether the language marks comments with `#` (script) or `//` (C-like). */
    private fun hashComments(lang: String): Boolean = when (lang.lowercase()) {
        "py", "python", "py3", "sh", "bash", "zsh", "shell", "console",
        "shell-session", "rb", "ruby", "yaml", "yml", "toml", "ini", "conf",
        -> true
        else -> false
    }

    /** Strings that can carry `{…}` interpolation, which gets its own ink. */
    private fun interpolates(lang: String): Boolean = when (lang.lowercase()) {
        "py", "python", "py3", "ts", "typescript", "tsx", "js", "javascript",
        "jsx", "kt", "kotlin", "cs", "csharp",
        -> true
        else -> false
    }

    /**
     * The block, coloured.
     *
     * A single pass over the characters, not a regex sweep: a regex pass would
     * have to colour strings first and then find numbers and words inside them,
     * and every such pipeline ends up highlighting the word `for` inside
     * "before". Here the scanner consumes a whole string or comment in one move
     * and never looks inside it again, which is the same order a lexer uses.
     */
    fun colorize(code: String, lang: String, ink: Ink): AnnotatedString {
        val keys = keywordsFor(lang)
        val hash = hashComments(lang)
        val interp = interpolates(lang)
        return buildAnnotatedString {
            var i = 0
            val n = code.length
            while (i < n) {
                val c = code[i]
                when {
                    // Line comment, either dialect.
                    (hash && c == '#') || (!hash && c == '/' && i + 1 < n && code[i + 1] == '/') -> {
                        val end = code.indexOf('\n', i).let { if (it < 0) n else it }
                        withStyle(SpanStyle(color = ink.comment, fontStyle = FontStyle.Italic)) {
                            append(code.substring(i, end))
                        }
                        i = end
                    }
                    // Block comment.
                    !hash && c == '/' && i + 1 < n && code[i + 1] == '*' -> {
                        val end = code.indexOf("*/", i + 2).let { if (it < 0) n else it + 2 }
                        withStyle(SpanStyle(color = ink.comment, fontStyle = FontStyle.Italic)) {
                            append(code.substring(i, end))
                        }
                        i = end
                    }
                    // A quoted run, with any interpolation inside it coloured
                    // apart - `f"Line {i}"` is one token to the lexer and two
                    // inks to the eye.
                    c == '"' || c == '\'' || c == '`' -> {
                        val triple = i + 2 < n && code[i + 1] == c && code[i + 2] == c
                        val quote = if (triple) code.substring(i, i + 3) else c.toString()
                        val bodyStart = i + quote.length
                        var j = bodyStart
                        var closed = false
                        while (j < n) {
                            if (code[j] == '\\' && j + 1 < n) { j += 2; continue }
                            if (code.startsWith(quote, j)) { closed = true; break }
                            if (!triple && code[j] == '\n') break
                            j++
                        }
                        val body = code.substring(bodyStart, j.coerceAtMost(n))
                        val tail = if (closed) quote else ""
                        withStyle(SpanStyle(color = ink.string)) { append(quote) }
                        if (interp) {
                            appendInterpolated(body, ink)
                        } else {
                            withStyle(SpanStyle(color = ink.string)) { append(body) }
                        }
                        if (tail.isNotEmpty()) withStyle(SpanStyle(color = ink.string)) { append(tail) }
                        i = (j + if (closed) quote.length else 0).coerceAtMost(n)
                    }
                    // A number: digits, with the decimal and exponent a literal
                    // may carry, but not the digits inside an identifier.
                    c.isDigit() && (i == 0 || !isIdent(code[i - 1])) -> {
                        var j = i
                        while (j < n && (code[j].isLetterOrDigit() || code[j] == '.' || code[j] == '_')) j++
                        withStyle(SpanStyle(color = ink.number)) { append(code.substring(i, j)) }
                        i = j
                    }
                    // An identifier: keyword, call, or plain.
                    isIdentStart(c) -> {
                        var j = i
                        while (j < n && isIdent(code[j])) j++
                        val word = code.substring(i, j)
                        val colour = when {
                            keys.contains(word) -> ink.keyword
                            // Named followed by an open paren reads as a call -
                            // `range(`, `print(`, `list.map(` - which is how
                            // the reference treats them.
                            isCall(code, j) -> ink.call
                            else -> ink.plain
                        }
                        val weight = if (keys.contains(word)) FontWeight.Medium else FontWeight.Normal
                        withStyle(SpanStyle(color = colour, fontWeight = weight)) { append(word) }
                        i = j
                    }
                    else -> {
                        withStyle(SpanStyle(color = ink.plain)) { append(c) }
                        i++
                    }
                }
            }
        }
    }

    /** `{…}` inside a string, in the interpolation ink. */
    private fun AnnotatedString.Builder.appendInterpolated(body: String, ink: Ink) {
        var i = 0
        var plainFrom = 0
        while (i < body.length) {
            if (body[i] == '{' && !(i > 0 && body[i - 1] == '\\')) {
                val close = body.indexOf('}', i)
                if (close > i) {
                    if (i > plainFrom) withStyle(SpanStyle(color = ink.string)) { append(body.substring(plainFrom, i)) }
                    withStyle(SpanStyle(color = ink.interpolation)) { append(body.substring(i, close + 1)) }
                    i = close + 1
                    plainFrom = i
                    continue
                }
            }
            i++
        }
        if (plainFrom < body.length) withStyle(SpanStyle(color = ink.string)) { append(body.substring(plainFrom)) }
    }

    /** The character after [end], skipping spaces, opens a call. */
    private fun isCall(code: String, end: Int): Boolean {
        var k = end
        while (k < code.length && (code[k] == ' ' || code[k] == '\t')) k++
        // `fn(` is a call; `fn (` is also one in the reference's blocks, but a
        // keyword already matched above and never reaches here.
        return k < code.length && code[k] == '('
    }

    private fun isIdentStart(c: Char) = c.isLetter() || c == '_' || c == '$'

    private fun isIdent(c: Char) = c.isLetterOrDigit() || c == '_' || c == '$'
}