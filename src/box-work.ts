/**
 * The work that exists only on a box: git projects with changes that are not
 * committed, or with branches that have commits that no remote has. `ferry
 * status` and `ferry box remove --uninstall` print it.
 *
 * Ferry checks the `projects` of `[box.<name>]` and the destinations of earlier
 * `ferry move` commands, which the box records in `~/.ferry/projects`. One box
 * command reads all of them. When the box has a box install of Ferry, its
 * output goes through `ferry redact` on the box, so a token in a path or a
 * branch name stays on the box. Only paths, branch names, and counts leave
 * the box. A stash does not count.
 */

import { quoteShell } from "./box-settings.ts";
import type { Link } from "./link.ts";
import { redactTokens, redactUrlCredentials } from "./manifest.ts";
import { plural, replaceControlCharacters } from "./progress.ts";

/** The record of `ferry move` destinations on a box, relative to the home. One project path on each line. */
export const BOX_PROJECTS_RECORD = ".ferry/projects";

/** The unsaved work of one git project or linked worktree. `path` is relative to the box home, or absolute outside the home. */
export type ProjectWork = {
  readonly path: string;
  /** The checked-out branch, or null when HEAD is detached. */
  readonly branch: string | null;
  /** The changed tracked files and the untracked files. */
  readonly changes: number;
  /**
   * Each local branch with commits that no remote-tracking branch has. A branch without a remote counts all its commits.
   * A detached HEAD with such commits has the branch `HEAD`.
   */
  readonly unpushed: readonly { readonly branch: string; readonly commits: number }[];
};

export type BoxWork = {
  /** The number of git projects and linked worktrees that Ferry checked, also the ones in `unchecked`. */
  readonly checked: number;
  /** Only the projects with unsaved work. */
  readonly projects: readonly ProjectWork[];
  /** The paths of the projects and worktrees where a git command failed. Their work is not known. */
  readonly unchecked: readonly string[];
};

/**
 * Print `project<TAB>path<TAB>branch<TAB>changes` for each git project and
 * each linked worktree of it, `branch<TAB>path<TAB>branch<TAB>commits` for
 * each branch and each detached HEAD with commits that no remote has, and
 * `error<TAB>path` for each project or worktree where a git command failed.
 * The arguments are the configured project paths. A path that is not a
 * directory, or a directory without `.git` that git does not know, is not a
 * project. GIT_OPTIONAL_LOCKS=0 keeps git status from writing the index.
 */
const WORK_SCRIPT = String.raw`
tree() {
  if ! c=$(GIT_OPTIONAL_LOCKS=0 git -C "$2" status --porcelain </dev/null 2>/dev/null); then printf 'error\t%s\n' "$1"; return; fi
  b=$(git -C "$2" symbolic-ref --short -q HEAD </dev/null 2>/dev/null)
  case $? in 0) ;; 1) b= ;; *) printf 'error\t%s\n' "$1"; return ;; esac
  printf 'project\t%s\t%s\t%s\n' "$1" "$b" "$(printf '%s\n' "$c" | grep -c .)"
  [ -n "$b" ] && return
  n=$(git -C "$2" rev-list --count HEAD --not --remotes </dev/null 2>/dev/null) || { printf 'error\t%s\n' "$1"; return; }
  [ "$n" -gt 0 ] 2>/dev/null && printf 'branch\t%s\tHEAD\t%s\n' "$1" "$n"
}
work() {
  cd "$HOME" || exit 1
  seen=
  { for p do printf '%s\n' "$p"; done; [ -f ${BOX_PROJECTS_RECORD} ] && cat ${BOX_PROJECTS_RECORD}; } | awk 'NF && !seen[$0]++' |
  while IFS= read -r p; do
    [ -d "$p" ] || continue
    if ! top=$(git -C "$p" rev-parse --show-toplevel </dev/null 2>/dev/null) || ! list=$(git -C "$p" worktree list --porcelain </dev/null 2>/dev/null); then
      [ -e "$p/.git" ] && printf 'error\t%s\n' "$p"
      continue
    fi
    main=$(printf '%s\n' "$list" | sed -n '1s/^worktree //p')
    case $seen in *"
$main
"*) continue ;; esac
    seen="$seen
$main
"
    tree "$p" "$p"
    refs=$(git -C "$p" for-each-ref --format='%(refname:short)' refs/heads </dev/null 2>/dev/null) || { printf 'error\t%s\n' "$p"; continue; }
    printf '%s\n' "$refs" | while IFS= read -r b; do
      [ -n "$b" ] || continue
      n=$(git -C "$p" rev-list --count "refs/heads/$b" --not --remotes </dev/null 2>/dev/null) || { printf 'error\t%s\n' "$p"; continue; }
      [ "$n" -gt 0 ] 2>/dev/null && printf 'branch\t%s\t%s\t%s\n' "$p" "$b" "$n"
    done
    printf '%s\n\n' "$list" | while IFS= read -r line; do
      case $line in
        "worktree "*) wt=$(printf '%s\n' "$line" | sed 's/^worktree //'); bare= ;;
        bare) bare=1 ;;
        "")
          if [ -n "$wt" ] && [ -z "$bare" ] && [ "$wt" != "$top" ] && [ -d "$wt" ]; then
            tree "$(printf '%s\n' "$wt" | awk -v home="$HOME/" 'index($0, home) == 1 { $0 = substr($0, length(home) + 1) } 1')" "$wt"
          fi
          wt= ;;
      esac
    done
  done
  true
}
out=$(work "$@") || exit 1
if [ -f "$HOME/.ferry/box.json" ] && redacted=$(printf '%s\n' "$out" | "$HOME/.local/bin/ferry" redact 2>/dev/null); then
  printf '%s\n' "$redacted"
else
  printf '%s\n' "$out"
fi
`;

/** The box command that reads the unsaved work of the configured projects and the recorded move destinations. */
export function boxWorkCommand(projects: readonly string[]): string {
  return ["sh", "-c", quoteShell(WORK_SCRIPT), "sh", ...projects.map(quoteShell)].join(" ");
}

/**
 * Read the lines of the box command. It ignores other lines. A box without a box install gets the token filter here.
 * The text comes from the box, so Ferry replaces its control characters.
 */
export function parseBoxWork(stdout: string): BoxWork {
  const projects = new Map<string, { path: string; branch: string | null; changes: number; unpushed: ProjectWork["unpushed"][number][] }>();
  const failed = new Set<string>();
  const clean = (text: string) => replaceControlCharacters(redactUrlCredentials(redactTokens(text)));
  for (const line of stdout.split(/\r?\n/)) {
    const [tag, path = "", branch = "", count = "", ...rest] = line.split("\t");
    if (tag === "error" && path !== "" && branch === "" && count === "" && rest.length === 0) {
      failed.add(path);
      continue;
    }
    const value = Number(count);
    if (rest.length > 0 || path === "" || !/^\d+$/.test(count)) continue;
    if (tag === "project") {
      projects.set(path, { path: clean(path), branch: branch === "" ? null : clean(branch), changes: value, unpushed: [] });
    } else if (tag === "branch" && branch !== "") {
      projects.get(path)?.unpushed.push({ branch: clean(branch), commits: value });
    }
  }
  for (const path of failed) projects.delete(path);
  const all = [...projects.values()];
  return {
    checked: all.length + failed.size,
    projects: all.filter((project) => project.changes > 0 || project.unpushed.length > 0),
    unchecked: [...failed].map(clean),
  };
}

/** Read the unsaved work of a box. */
export async function readBoxWork(link: Pick<Link, "run">, projects: readonly string[]): Promise<BoxWork> {
  const result = await link.run(boxWorkCommand(projects));
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  return parseBoxWork(result.stdout);
}

/** The heading line, then one line for each project with unsaved work, and one for each project that Ferry could not check. */
export function boxWorkLines(work: BoxWork, box: string): string[] {
  if (work.checked === 0) {
    return [`Unsaved work: no projects to check. Add projects to [box.${box}], or move a project to the box with ferry move.`];
  }
  if (work.projects.length === 0 && work.unchecked.length === 0) return [`Unsaved work: none in ${plural(work.checked, "project")}`];
  const shown = (path: string) => (path.startsWith("/") ? path : `~/${path}`);
  return [
    work.projects.length > 0
      ? `Unsaved work: ${work.projects.length} of ${plural(work.checked, "project")}, only on the box`
      : `Unsaved work: could not check ${work.unchecked.length} of ${plural(work.checked, "project")}`,
    ...work.projects.map((project) => {
      const parts = [
        ...(project.changes > 0 ? [`${plural(project.changes, "changed file")}`] : []),
        ...project.unpushed.map((entry) => `${entry.branch} has ${plural(entry.commits, "commit")} that no remote has`),
      ];
      return `  ${shown(project.path)} (${project.branch ?? "detached HEAD"}): ${parts.join(", ")}`;
    }),
    ...work.unchecked.map((path) => `  ${shown(path)}: could not check`),
  ];
}
