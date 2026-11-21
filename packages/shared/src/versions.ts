/** "v1.2.3" / "1.2.3-rc.1" -> [1,2,3]; null when it is not a version. Pre-release suffixes are ignored. */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true when `latest` is a higher version than `current`. Unknown versions never count as "newer". */
export function isNewerVersion(latest: string | null | undefined, current: string | null | undefined): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
