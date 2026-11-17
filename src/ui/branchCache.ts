import type { Page } from "../shared/types";

// Bound retained off-screen pages, including empty/error-only branches.
// Visible branches remain available to the layout and paging controls.
export function trimBranches(
  pages: Record<string, Page>,
  current: string,
  visible: { has(key: string): boolean },
): Record<string, Page> {
  let entries = Object.values(pages).reduce((n, p) => n + p.entries.length, 0);
  let branches = Object.keys(pages).length;
  for (const key of Object.keys(pages)) {
    if (entries <= 16000 && branches <= 128) break;
    if (key === current || visible.has(key)) continue;
    entries -= pages[key].entries.length;
    branches--;
    delete pages[key];
  }
  return pages;
}
