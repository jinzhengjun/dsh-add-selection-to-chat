/**
 * dsh-add-selection-to-chat — host half.
 *
 * This plugin is browser-only: every behaviour lives in `client.js`, which the
 * web shell loads as the package's `./client` bundle. The empty `apply` exists
 * so the package is a valid cordis plugin row (the Loader must see it as
 * enabled before `dsh-client-modules` publishes its bundle under `/plugins`).
 */
export function apply() {}
