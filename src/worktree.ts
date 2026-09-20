/**
 * Replica worktree isolation (ADR-035): when a spec fans out (`count > 1`),
 * each replica child launches into its own git worktree so sibling writers
 * never share a directory — the single-writer-ownership baseline made
 * structural. The existing `cwd` launch parameter is the entire seam:
 * `prepare` returns the directory the child must start in and the launch path
 * passes it through unchanged; there is no new launch surface.
 *
 * Layout, under the repository's existing `.herdr` convention:
 *
 *   <repo>/.herdr/worktrees/<childName>/           one detached-HEAD worktree
 *   <repo>/.herdr/worktrees/.meta/<childName>.json   provenance marker
 *   <repo>/.herdr/worktrees/creation.lock           serializes every mutation
 *
 * Owned invariants:
 *
 * - `count <= 1` is a pass-through: no worktree, no `.herdr` writes, the
 *   caller's `cwd` returned unchanged — today's single-child behaviour.
 * - The worktree exists before the child's first effect: `prepare` finishes
 *   it before the caller spawns anything, and every create failure throws
 *   `WorktreeError` — a typed pre-spawn failure the attempts machinery may
 *   retry on the next chain entry — leaving no partial worktree behind.
 * - A `cwd` that does not resolve inside a git work tree is refused rather
 *   than silently shared.
 * - Every mutation runs inside the same flock section, so concurrent creates
 *   and removals serialize across every host sharing the repository.
 * - Removal never deletes a path this host did not create. Inside the
 *   process the `created` registry is the proof; across restarts the `.meta`
 *   marker is, which is also what lets a same-name `prepare` reclaim a stale
 *   own replica while a foreign directory at the path is refused outright.
 *
 * Removal rides the self-close tracker's `onPaneClosed` listeners: a `consume`
 * observation (a self-close or third-party close the supervisor saw absent)
 * and a readback-confirmed own-close are the two ways this host proves a pane
 * gone, so both fire the hook. `git worktree remove --force` discards whatever
 * the replica left uncommitted — replica worktrees are ephemeral writers and
 * durable handoff flows through the handoff channel, so worktree lifetime
 * stays tied to the child's. Removal never throws: a failed removal leaves a
 * provably-owned directory that a later same-name `prepare` reclaims, and
 * throwing could not un-close the pane.
 *
 * ponytail: the pane→child binding is learned at launch and cannot follow a
 * `herdr_pane move` — a moved replica's worktree is left for the marker-based
 * reclaim on name reuse rather than a topology watcher this node cannot
 * afford. The upgrade path is a move notification, not a wider hook.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { AGENT_NAME_MAX_LENGTH, isAgentName } from "./agent-identity.js";
import type { PiExec } from "./cli.js";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "./pane-write-lock.js";
import type { SelfCloseTracker } from "./supervision/self-close.js";

export type WorktreeErrorCode =
  | "WORKTREE_NOT_A_REPOSITORY"
  | "WORKTREE_NAME_INVALID"
  | "WORKTREE_PATH_OCCUPIED"
  | "WORKTREE_UNAVAILABLE"
  | "WORKTREE_CREATE_FAILED";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

const unavailable = (message: string): WorktreeError => new WorktreeError("WORKTREE_UNAVAILABLE", message);

/** Bound on flock's own contention wait for one worktree mutation. */
export const WORKTREE_LOCK_WAIT_MS = 5_000;
/** Bound on each git invocation; worktree operations are local. */
export const WORKTREE_GIT_TIMEOUT_MS = 10_000;
const WORKTREE_READY = "HERDR_WORKTREE_LOCK_READY";

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export interface WorktreePaths {
  /** `<repo>/.herdr/worktrees` — parent of every replica worktree. */
  root: string;
  /** `<repo>/.herdr/worktrees/.meta` — one provenance marker per replica. */
  meta: string;
  /** `<repo>/.herdr/worktrees/creation.lock` — serializes every mutation. */
  lock: string;
}

/** The `.herdr` worktree layout under one resolved repository root. */
export function worktreePaths(repoRoot: string): WorktreePaths {
  const root = join(repoRoot, ".herdr", "worktrees");
  return { root, meta: join(root, ".meta"), lock: join(root, "creation.lock") };
}

function markerPath(meta: string, childName: string): string {
  return join(meta, `${childName}.json`);
}

export interface ReplicaPrepare {
  /** The child's exact derived launch name; also the worktree directory name. */
  childName: string;
  /** The caller's launch `cwd`, applied unchanged for `count <= 1`. */
  cwd: string;
  /** The spec's replica count; `> 1` is what makes this child a replica. */
  count: number;
  signal?: AbortSignal;
}

export interface PreparedReplica {
  /** The directory the child's `cwd` launch parameter receives. */
  cwd: string;
  /** The created worktree root; absent on the `count <= 1` pass-through. */
  worktreePath?: string;
}

export interface WorktreeManagerOptions {
  /** The host's process runner; `git -C` keeps every call cwd-independent. */
  exec: PiExec;
  /**
   * The host's own-close ledger. When present, the manager registers a removal
   * listener so close and self-close observations reclaim bound replicas.
   */
  selfClose?: SelfCloseTracker;
  /** Bound on flock's own contention wait (default {@link WORKTREE_LOCK_WAIT_MS}). */
  waitMs?: number;
  /** Bound on the holder's ready marker; defaults to waitMs plus spawn margin. */
  deadlineMs?: number;
  /** Bound on each git invocation (default {@link WORKTREE_GIT_TIMEOUT_MS}). */
  gitTimeoutMs?: number;
}

export interface WorktreeManager {
  /**
   * Resolve the directory one child launches into. `count <= 1` returns `cwd`
   * unchanged with zero effects. `count > 1` creates the replica's detached
   * worktree before any child effect and returns the caller `cwd`'s matching
   * offset inside it, so a subdirectory `cwd` keeps its meaning. Throws
   * `WorktreeError` — a typed pre-spawn failure.
   */
  prepare(options: ReplicaPrepare): Promise<PreparedReplica>;
  /**
   * Associate a created replica with its pane once known, so close and
   * self-close observations reach it. Binding a name with no live worktree is
   * a no-op — there is nothing to remove.
   */
  bindPane(childName: string, paneId: string): void;
  /**
   * Idempotent removal of a replica this host created — the path a caller
   * takes when launch fails between `prepare` and `bindPane`. Never throws
   * and never touches a path the `created` registry does not prove ours.
   */
  release(childName: string): Promise<void>;
  /** The tracker's pane-gone observation: removes the bound replica, if any. */
  onPaneClosed(paneId: string): Promise<void>;
}

export function createWorktreeManager(options: WorktreeManagerOptions): WorktreeManager {
  const { exec } = options;
  /** Replicas this process created and has not yet removed — the removal proof. */
  const created = new Map<string, { path: string; repoRoot: string }>();
  /** paneId → childName, bound once the launched pane id is known. */
  const panes = new Map<string, string>();

  async function git(repoRoot: string, args: string[], signal?: AbortSignal): Promise<ExecResult> {
    try {
      return await exec("git", ["-C", repoRoot, ...args], {
        timeout: options.gitTimeoutMs ?? WORKTREE_GIT_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw unavailable("git could not be executed");
    }
  }

  /** The `.herdr`, `worktrees`, and `.meta` directories are created owner-only and then proven trusted. */
  async function ensureDirectories(paths: WorktreePaths): Promise<void> {
    for (const path of [dirname(paths.root), paths.root, paths.meta]) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw unavailable("Replica worktree directory is unavailable");
      }
      let value;
      try {
        value = await lstat(path);
      } catch {
        throw unavailable("Replica worktree directory is unavailable");
      }
      assertOwnerOnlyDirectory(path, value, unavailable, "Replica worktree");
    }
  }

  async function resolveRepo(cwd: string, signal?: AbortSignal): Promise<{ repoRoot: string; inner: string }> {
    if (!isAbsolute(cwd)) {
      throw new WorktreeError("WORKTREE_NOT_A_REPOSITORY", "replica cwd must be an absolute path inside a git work tree");
    }
    let resolvedCwd: string;
    try {
      resolvedCwd = await realpath(cwd);
    } catch {
      throw new WorktreeError("WORKTREE_NOT_A_REPOSITORY", "replica cwd is not an existing directory");
    }
    const probe = await git(resolvedCwd, ["rev-parse", "--show-toplevel"], signal);
    if (probe.code === 128) {
      throw new WorktreeError("WORKTREE_NOT_A_REPOSITORY", "replica cwd is not inside a git work tree");
    }
    if (probe.code !== 0 || probe.killed) throw unavailable("git could not resolve the replica repository");
    let repoRoot: string;
    try {
      repoRoot = await realpath(probe.stdout.trim());
    } catch {
      throw unavailable("git reported an indeterminate repository root");
    }
    // rev-parse ran inside the cwd, so its toplevel always contains it; a
    // reported root that does not is an untrusted answer, not a subdir path.
    const inner = relative(repoRoot, resolvedCwd);
    if (inner.startsWith("..")) {
      throw unavailable("replica cwd escapes its resolved repository root");
    }
    return { repoRoot, inner };
  }

  /**
   * The marker is the cross-process proof that this facility created the
   * worktree at `path` — the only circumstance under which a directory found
   * at the deterministic path may be removed by a later incarnation.
   */
  async function markerProves(meta: string, childName: string, path: string): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(markerPath(meta, childName), "utf8"));
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null) return false;
    const candidate = parsed as { v?: unknown; path?: unknown };
    return candidate.v === 1 && candidate.path === path;
  }

  async function writeMarker(path: string, worktreePath: string): Promise<void> {
    /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
    const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(path, flags, 0o600);
    } catch {
      throw unavailable("Replica worktree marker is unavailable");
    }
    try {
      await handle.writeFile(JSON.stringify({ v: 1, path: worktreePath }));
    } finally {
      // A failed close cannot unwrite what the append already did; the marker
      // is re-validated on read, so close errors settle quietly.
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * `git worktree remove --force` first — it clears both the directory and
   * git's administrative entry. When that reports failure the fallback prunes
   * now-orphaned admin entries and removes the leftover directory; when git
   * itself cannot run the path is left whole for a later reclaim. Callers only
   * reach this for paths already proven ours, and it never throws.
   */
  async function removeGitWorktree(repoRoot: string, path: string, signal?: AbortSignal): Promise<void> {
    try {
      const removed = await git(repoRoot, ["worktree", "remove", "--force", path], signal);
      if (removed.code === 0 && !removed.killed) return;
    } catch {
      // git itself is unavailable; deleting the directory while its admin
      // entry may survive would strand the registration, so leave both.
      return;
    }
    await git(repoRoot, ["worktree", "prune", "--expire", "now"], signal).catch(() => undefined);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }

  async function lockSection(paths: WorktreePaths): Promise<{ release(): Promise<void> }> {
    return acquireFlockHolder({
      lockPath: paths.lock,
      wait: { timeoutMs: options.waitMs ?? WORKTREE_LOCK_WAIT_MS },
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      readyMarker: WORKTREE_READY,
      subject: "Replica worktree",
      failure: unavailable,
    });
  }

  async function pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw unavailable("Replica worktree path is indeterminate");
    }
  }

  /**
   * Conservative absence check for post-removal state: only ENOENT counts as
   * gone, so an indeterminate path keeps its provenance marker and stays
   * reclaimable rather than orphaned.
   */
  async function pathGone(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      return isNodeError(error, "ENOENT");
    }
  }

  /** Locked removal of a proven-own replica; never throws. */
  async function drop(childName: string): Promise<void> {
    const entry = created.get(childName);
    if (entry === undefined) return;
    created.delete(childName);
    for (const [paneId, name] of [...panes]) {
      if (name === childName) panes.delete(paneId);
    }
    try {
      const paths = worktreePaths(entry.repoRoot);
      const holder = await lockSection(paths);
      try {
        await removeGitWorktree(entry.repoRoot, entry.path);
        // The marker is the reclaim proof: drop it only once the directory is
        // actually gone, or a failed removal would orphan the worktree.
        if (await pathGone(entry.path)) await rm(markerPath(paths.meta, childName), { force: true });
      } finally {
        // A failed release cannot recall the removal; the kernel frees the
        // flock when the holder dies.
        await holder.release().catch(() => undefined);
      }
    } catch {
      // Removal settles quietly: a lock or filesystem failure leaves a
      // provably-owned directory under `.herdr/worktrees/` that a later
      // same-name `prepare` reclaims.
    }
  }

  async function prepare(prepareOptions: ReplicaPrepare): Promise<PreparedReplica> {
    const { childName, cwd, count, signal } = prepareOptions;
    // `count: 1` keeps today's behaviour exactly: no worktree, no `.herdr`
    // writes, the caller's `cwd` passed through untouched.
    if (!(count > 1)) return { cwd };
    try {
      if (!isAgentName(childName)) {
        throw new WorktreeError("WORKTREE_NAME_INVALID", `replica child name is outside the ${AGENT_NAME_MAX_LENGTH}-character AgentName contract`);
      }
      const { repoRoot, inner } = await resolveRepo(cwd, signal);
      const paths = worktreePaths(repoRoot);
      await ensureDirectories(paths);
      const holder = await lockSection(paths);
      try {
        // A name with a live worktree in this process belongs to a running
        // replica; a second claim is a caller bug, refused before any effect.
        if (created.has(childName)) {
          throw new WorktreeError("WORKTREE_PATH_OCCUPIED", `replica ${childName} already owns a live worktree`);
        }
        const path = join(paths.root, childName);
        if (await pathExists(path)) {
          // Only a proven-stale own replica may be reclaimed at the
          // deterministic path; a directory without the marker is foreign
          // and refuses rather than being removed.
          if (!(await markerProves(paths.meta, childName, path))) {
            throw new WorktreeError("WORKTREE_PATH_OCCUPIED", `replica path is held by a directory this host did not create: ${path}`);
          }
          await removeGitWorktree(repoRoot, path, signal);
          // Keep the marker if the stale directory survived its removal: the
          // proof of ownership outlives the failure that needed it.
          if (await pathGone(path)) await rm(markerPath(paths.meta, childName), { force: true });
          else throw new WorktreeError("WORKTREE_CREATE_FAILED", `stale replica path could not be cleared: ${path}`);
        }
        const added = await git(repoRoot, ["worktree", "add", "--detach", path, "HEAD"], signal);
        if (added.code !== 0 || added.killed) {
          // No partial worktree survives a failed add: git's own removal runs
          // first, then the bounded fallback clears the exact path we tried.
          await removeGitWorktree(repoRoot, path, signal);
          throw new WorktreeError("WORKTREE_CREATE_FAILED", "git worktree add failed");
        }
        try {
          await writeMarker(markerPath(paths.meta, childName), path);
        } catch (error) {
          await removeGitWorktree(repoRoot, path);
          throw error instanceof WorktreeError ? error : unavailable("Replica worktree marker is unavailable");
        }
        created.set(childName, { path, repoRoot });
        return { cwd: inner === "" ? path : join(path, inner), worktreePath: path };
      } finally {
        await holder.release().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof WorktreeError) throw error;
      throw unavailable("Replica worktree is unavailable");
    }
  }

  function bindPane(childName: string, paneId: string): void {
    if (!created.has(childName)) return;
    panes.set(paneId, childName);
  }

  async function onPaneClosed(paneId: string): Promise<void> {
    const childName = panes.get(paneId);
    if (childName === undefined) return;
    await drop(childName);
  }

  options.selfClose?.onPaneClosed((paneId) => {
    void onPaneClosed(paneId);
  });

  return { prepare, bindPane, release: drop, onPaneClosed };
}
