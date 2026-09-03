/**
 * Naming and colouring a project directory.
 *
 * The name half was five near-copies scattered across the components that show
 * a project, which is how they drifted apart: some honoured a name the user had
 * set, some always showed the folder, and the recent-projects list showed the
 * whole path. One place to change means they cannot disagree again.
 */

/**
 * A stable colour for a directory, so its badge looks the same every launch.
 *
 * Derived from the path rather than stored, which is what lets a project keep
 * its colour without anything being written down for it.
 */
export function projectHue(directory: string): number {
  let hash = 0
  for (let i = 0; i < directory.length; i++) hash = (hash * 31 + directory.charCodeAt(i)) | 0
  return Math.abs(hash) % 360
}

/** Last segment of a path, whichever separator it uses. */
export function folderName(directory: string): string {
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
}

/**
 * Display name for a project: what the user called it, else the folder.
 *
 * @param names the projectNames map from config; omit it only where the folder
 *   name is what is wanted regardless, such as the default in the rename field.
 */
export function projectName(directory: string, names?: Record<string, string>): string {
  return names?.[directory] ?? folderName(directory)
}
