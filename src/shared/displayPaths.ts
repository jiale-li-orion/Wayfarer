const backslash = String.fromCharCode(92);
export function pathSegments(value: string, windows: boolean): string[] {
  return (windows ? value.replaceAll(backslash, "/") : value)
    .split("/")
    .filter(Boolean);
}
export function parentPath(value: string, windows: boolean): string {
  const parts = pathSegments(value, windows);
  if (!windows) return "/" + parts.slice(0, -1).join("/");
  const unc = value.startsWith(backslash + backslash) || value.startsWith("//");
  if (unc) {
    const parent = parts.length <= 2 ? parts : parts.slice(0, -1);
    return (
      backslash +
      backslash +
      parent.join(backslash) +
      (parent.length === 2 ? backslash : "")
    );
  }
  const parent = parts.length <= 1 ? parts : parts.slice(0, -1);
  return parent.join(backslash) + (parent.length === 1 ? backslash : "");
}
export function breadcrumbsFor(value: string, windows: boolean) {
  const result: { label: string; path: string }[] = [];
  let current = windows ? value.replaceAll("/", backslash) : value;
  const comparable = (p: string) =>
    (windows ? p.replaceAll(backslash, "/") : p).replace(/\/$/, "");
  for (let i = 0; i < 3; i++) {
    result.push({
      label: pathSegments(current, windows).at(-1) ?? "/",
      path: current,
    });
    const parent = parentPath(current, windows);
    if (comparable(parent) === comparable(current)) break;
    current = parent;
  }
  return result.reverse();
}
