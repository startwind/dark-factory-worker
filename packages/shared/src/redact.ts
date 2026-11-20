/** Masks known secrets and common token shapes in log lines. */
const PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(?<=Bearer\s)[A-Za-z0-9._-]{20,}/g,
  /(?<=:\/\/[^:\s/]+:)[^@\s/]{6,}(?=@)/g,
  /ATATT[A-Za-z0-9_=-]{20,}/g,
];

export function makeRedactor(secrets: string[] = []) {
  const literals = secrets.filter((s) => s && s.length >= 6);
  return (text: string): string => {
    let out = text;
    for (const s of literals) out = out.split(s).join('***');
    for (const p of PATTERNS) out = out.replace(p, '***');
    return out;
  };
}
