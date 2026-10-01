import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The git work-tree proof both launch boundaries share: a `.git` entry — a
 * directory, or the pointer file a linked worktree writes — on the directory
 * or any ancestor is the proof. An unreadable entry proves nothing either
 * way, so the walk continues and only a path with no `.git` at all answers
 * false. Each boundary keeps its own refusal code.
 */
export async function insideGitWorkTree(resolved: string): Promise<boolean> {
  let dir = resolved;
  for (;;) {
    try {
      await stat(join(dir, ".git"));
      return true;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}
