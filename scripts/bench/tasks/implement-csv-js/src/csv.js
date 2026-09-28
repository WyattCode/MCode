/**
 * Parses CSV text into rows of strings.
 *
 * Fields are separated by commas and rows by line breaks (\n or \r\n). A field
 * may be wrapped in double quotes, and then it can hold commas, line breaks
 * and quotes, a quote being written twice (""). A line break at the very end
 * does not start another row. Empty input is no rows.
 */
function parseCSV(text) {
  throw new Error("not implemented")
}

/**
 * The reverse: rows of strings as CSV text, rows joined with \n and no line
 * break at the end. A field is quoted only when it has to be - when it holds a
 * comma, a quote, a line break, or starts or ends with a space.
 */
function toCSV(rows) {
  throw new Error("not implemented")
}

module.exports = { parseCSV, toCSV }
