/**
 * Best-effort secret rejection heuristic for project memory writes.
 *
 * This is deliberately a small set of well-known token/key shapes. It is NOT
 * a security guarantee: novel formats will pass, and legitimate prose that
 * happens to match will be rejected. It must never log, return, or include
 * the inspected text anywhere — callers surface only a fixed "sensitive"
 * rejection reason.
 */
// --- Shared fragments for key/value assignment patterns -------------------
// All quantifiers are bounded (or sit between disjoint character classes) so
// matching stays linear-ish on adversarial input.

const KEYWORD =
  "(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)";
// `tokenCount`, `token_limit`, `password_policy` … name a number/setting, not a secret.
const NON_SECRET_SUFFIX =
  "(?:count|limit|length|max|min|size|type|name|expir|ttl|budget|usage|bucket|policy|reset|url|path|file|header|field)";
// Key identifier containing a secret-ish word: SECRET_KEY, aws_secret_access_key, x-api-key, "password".
const KEY_NAME = `\\b[\\w.-]{0,40}${KEYWORD}(?![_-]?${NON_SECRET_SUFFIX})[\\w-]{0,40}`;
// Values that are obviously not real secrets: masks, env references, dotted identifiers.
const PLACEHOLDER =
  "(?!(?:x{3,}|your|changeme|change_me|example|placeholder|redacted|process\\.env|os\\.environ|env\\.|none\\b|null\\b|undefined\\b|true\\b|false\\b|\\$|\\*)|[A-Za-z_]+(?:\\.[A-Za-z_]+)+(?![^\\s\"'`<>(){}\\[\\],;]))";
const UNQUOTED_CHARS = "[^\\s\"'`<>(){}\\[\\],;]";
// Unquoted values must contain a digit or symbol so prose / identifiers ("passwordInput") do not match.
const UNQUOTED_VALUE = `(?=${UNQUOTED_CHARS}*[0-9!@#%^&+=/])[A-Za-z0-9!@#%^&+]${UNQUOTED_CHARS}{7,}(?!${UNQUOTED_CHARS}|\\()`;
const QUOTE = "[\"'`]";

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  // PEM private key blocks.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/,
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_).
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // OpenAI / Anthropic style API keys.
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/,
  // Stripe secret / restricted keys (underscore form).
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // npm and Hugging Face access tokens.
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bhf_[A-Za-z0-9]{30,}\b/,
  // Telegram bot tokens (<bot id>:<35 chars>).
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  // Bearer-style JWT triplets.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Opaque bearer credentials: explicit Authorization header, or a long digit-bearing bare token.
  /\bauthorization["'`]?[ \t]*[:=][ \t]*["'`]?(?:bearer|basic|token)[ \t]+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bbearer[ \t]+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}/i,
  // Credentials embedded in URLs: scheme://user:password@host.
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'<>]{1,64}:(?![$*]|x+@)[^\s/@"'<>]{3,}@[^\s/"'<>]+/i,
  // Long secret-looking assignment values (api_key = "…", secret: …, token=…).
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'`]?[A-Za-z0-9/_+=-]{20,}/i,
  // Named-key assignments with shorter values (SECRET_KEY=…, password: hunter2hunter2).
  new RegExp(
    `${KEY_NAME}${QUOTE}?[ \t]*[:=][ \t]*(?!${QUOTE})(?!https?://)${PLACEHOLDER}${UNQUOTED_VALUE}`,
    "i",
  ),
  new RegExp(`${KEY_NAME}${QUOTE}?[ \t]*[:=][ \t]*${QUOTE}${PLACEHOLDER}[^\\s"'\`<>{}()]{8,}`, "i"),
  // Korean: 비밀번호는 abc12345, 비번: …, 토큰: …  (needs an ASCII value with a letter and a digit/symbol).
  new RegExp(
    `(?:비밀번호|비번|패스워드|암호|토큰|시크릿|인증키|api[ \t]?키)[ \t]*(?:[:=]|[은는이가])[ \t]*${QUOTE}?${PLACEHOLDER}(?=[A-Za-z0-9!@#%^&+=_./~-]*[A-Za-z])(?=[A-Za-z0-9!@#%^&+=_./~-]*[0-9!@#%^&+=/])[A-Za-z0-9!@#%^&+][A-Za-z0-9!@#%^&+=_./~-]{7,}(?![A-Za-z0-9!@#%^&+=_./~-]|\\()`,
    "i",
  ),
];

export function looksLikeSensitiveText(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
