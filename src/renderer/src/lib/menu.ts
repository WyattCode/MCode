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
  /** Drawn in the error colour: the row that destroys something. */
  danger?: boolean
}
