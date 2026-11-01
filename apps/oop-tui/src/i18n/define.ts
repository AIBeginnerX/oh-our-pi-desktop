/**
 * One area's strings. `ko` must have exactly the keys of `en`, so a missing translation is a type
 * error. `{name}` in a string is filled by `t(key, { name })`.
 */
export const defineMessages = <const E extends Readonly<Record<string, string>>>(
  en: E,
  ko: { readonly [K in keyof E]: string },
): { readonly en: E; readonly ko: { readonly [K in keyof E]: string } } => ({ en, ko });
