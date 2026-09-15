/**
 * One entry in a right-click menu.
 *
 * Lives beside the component rather than inside it: a `<script setup>` block
 * cannot export, and every caller needs to name this type to build its list.
 */
export interface MenuItem {
  key: string
  label: string
  /** A disabled item is shown greyed rather than hidden, so the menu holds its shape. */
  enabled?: boolean
  /** Draws a rule above this item. */
  divided?: boolean
  /**
   * A ticked item, for a menu that is choosing rather than acting.
   *
   * opencode draws these as a DropdownMenu.RadioGroup - the open-in menu is
   * the one place a menu here remembers an answer instead of running a command.
   */
  checked?: boolean
  /** The tick sits at the row's far end instead of before the label, as MiMo's sort choices have it. */
  checkEnd?: boolean
  /** A group's name rather than something to press, like its GroupLabel. */
  heading?: boolean
  /**
   * The row's glyph, as an SVG path on a 16x16 grid.
   *
   * A path rather than a component: a menu is built as data by whoever opens
   * it, and passing components through that list would make every caller
   * import the icons it names.
   */
  icon?: string
  /** The glyph's own colour, such as a file type's hue in the files tab; the row's ink otherwise. */
  iconColor?: string
  /** Drawn in the error colour: the row that destroys something. */
  danger?: boolean
  /** The shortcut that does the same, shown at the far end of the row. */
  hint?: string
  /** Highlighted as the current choice, like the project a conversation is already in. */
  active?: boolean
  /** Text straight after the label, such as the order a list is sorted in. */
  value?: string
  /** Opens a panel beside this row instead of running anything itself. */
  children?: MenuItem[]
  /** A search field pinned to the top of the child panel, filtering its rows by label. */
  search?: { placeholder: string; empty: string }
  /** Rows kept below a rule at the foot of the child panel, whatever the search leaves. */
  footer?: MenuItem[]
  /** The child panel's narrowest width. */
  childWidth?: number
  /** Never hidden by the search, like "move out of project" above the list it filters. */
  sticky?: boolean
}

/**
 * The rows of a child panel that a search leaves.
 *
 * Sticky rows always stay; the rest match on their label, ignoring case and
 * surrounding space. Kept apart from the component so it can be checked without
 * a window.
 */
export function filterMenu(items: MenuItem[], query: string): { rows: MenuItem[]; matched: number } {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return { rows: items, matched: items.filter((item) => !item.sticky).length }
  const rows = items.filter((item) => item.sticky || item.label.toLocaleLowerCase().includes(needle))
  return { rows, matched: rows.filter((item) => !item.sticky).length }
}
