const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  {
    name: "Brainfeather API key",
    pattern: /\bbf_(?:(?:live|test)_[A-Za-z0-9]{16,128}|[A-Fa-f0-9]{16,128})\b/,
  },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    name: "assigned credential",
    pattern:
      /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  { name: "credential-bearing URL", pattern: /https?:\/\/[^\s/@:]+:[^\s/@]+@/i },
  { name: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: "US Social Security number", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  {
    name: "payment card number",
    pattern: /\b(?:\d[ -]*?){13,19}\b/,
  },
];

export function secretReason(value: string): string | null {
  const match = SECRET_PATTERNS.find(({ pattern }) => pattern.test(value));
  return match ? `contains sensitive data (${match.name})` : null;
}

/** Stored memories are untrusted data. Keep each item on one printable line
 * so it cannot create fake sections or control the terminal/client parser. */
export function cleanMemoryText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
