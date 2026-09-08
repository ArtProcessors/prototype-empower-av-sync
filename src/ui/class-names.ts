/**
 * Joins the class names that apply and drops the ones that do not.
 *
 * Exists because CSS Modules turns every class name into a variable: what used
 * to be one string literal in JSX is now several values, some of them
 * conditional, and a template literal over those either repeats the module
 * prefix at every interpolation or quietly writes `undefined` into the
 * attribute when a condition is false.
 *
 * @param names class names to apply; `false`, `null` and `undefined` are
 *   skipped, so a condition can be inlined as `flag && styles.thing`
 * @returns the applying names, space separated
 */
export function classNames(
  ...names: (string | false | null | undefined)[]
): string {
  return names.filter(Boolean).join(' ')
}
