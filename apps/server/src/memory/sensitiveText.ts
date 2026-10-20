/**
 * Best-effort secret rejection heuristic for project memory writes.
 *
 * This is deliberately a small set of well-known token/key shapes. It is NOT
 * a security guarantee: novel formats will pass, and legitimate prose that
 * happens to match will be rejected. It must never log, return, or include
 * the inspected text anywhere — callers surface only a fixed "sensitive"
 * rejection reason.
 */
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
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Bearer-style JWT triplets.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Long secret-looking assignment values (api_key = "…", secret: …, token=…).
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'`]?[A-Za-z0-9/_+=-]{20,}/i,
];

export function looksLikeSensitiveText(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
