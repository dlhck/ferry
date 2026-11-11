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
import { plural } from "./progress.ts";

/** The record of `ferry move` destinations on a box, relative to the home. One project path on each line. */
export const BOX_PROJECTS_RECORD = ".ferry/projects";

/** The unsaved work of one git project. `path` is relative to the box home. */
export type ProjectWork = {
  readonly path: string;
  /** The checked-out branch, or null when HEAD is detached. */
  readonly branch: string | null;
  /** The changed tracked files and the untracked files. */
  readonly changes: number;
  /** Each local branch with commits that no remote-tracking branch has. A branch without a remote counts all its commits. */
  readonly unpushed: readonly { readonly branch: string; readonly commits: number }[];
};

export type BoxWork = {
  /** The number of git projects that Ferry checked. */
  readonly checked: number;
  /** Only the projects with unsaved work. */
  readonly projects: readonly ProjectWork[];
};

/**
 * Print `project<TAB>path<TAB>branch<TAB>changes` for each git project, and
 * `branch<TAB>path<TAB>branch<TAB>commits` for each branch with commits that no
 * remote has. The arguments are the configured project paths. GIT_OPTIONAL_LOCKS=0
 * keeps git status from writing the index.
 */
const WORK_SCRIPT = String.raw`
work() {
  cd "$HOME" || exit 1
  { for p do printf '%s\n' "$p"; done; [ -f ${BOX_PROJECTS_RECORD} ] && cat ${BOX_PROJECTS_RECORD}; } | awk 'NF && !seen[$0]++' |
  while IFS= read -r p; do
    [ -d "$p" ] && git -C "$p" rev-parse --git-dir >/dev/null 2>&1 </dev/null || continue
    branch=$(git -C "$p" symbolic-ref --short -q HEAD </dev/null)
    changes=$(GIT_OPTIONAL_LOCKS=0 git -C "$p" status --porcelain </dev/null 2>/dev/null | wc -l | tr -d ' ')
    printf 'project\t%s\t%s\t%s\n' "$p" "$branch" "$changes"
    git -C "$p" for-each-ref --format='%(refname:short)' refs/heads </dev/null | while IFS= read -r b; do
      n=$(git -C "$p" rev-list --count "refs/heads/$b" --not --remotes </dev/null 2>/dev/null)
      [ "$n" -gt 0 ] 2>/dev/null && printf 'branch\t%s\t%s\t%s\n' "$p" "$b" "$n"
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

/** Read the lines of the box command. It ignores other lines. A box without a box install gets the token filter here. */
export function parseBoxWork(stdout: string): BoxWork {
  const projects = new Map<string, { path: string; branch: string | null; changes: number; unpushed: ProjectWork["unpushed"][number][] }>();
  const clean = (text: string) => redactUrlCredentials(redactTokens(text));
  for (const line of stdout.split(/\r?\n/)) {
    const [tag, path = "", branch = "", count = "", ...rest] = line.split("\t");
    const value = Number(count);
    if (rest.length > 0 || path === "" || !/^\d+$/.test(count)) continue;
    if (tag === "project") {
      projects.set(path, { path: clean(path), branch: branch === "" ? null : clean(branch), changes: value, unpushed: [] });
    } else if (tag === "branch" && branch !== "") {
      projects.get(path)?.unpushed.push({ branch: clean(branch), commits: value });
    }
  }
  const all = [...projects.values()];
  return { checked: all.length, projects: all.filter((project) => project.changes > 0 || project.unpushed.length > 0) };
}

/** Read the unsaved work of a box. */
export async function readBoxWork(link: Pick<Link, "run">, projects: readonly string[]): Promise<BoxWork> {
  const result = await link.run(boxWorkCommand(projects));
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  return parseBoxWork(result.stdout);
}

/** The heading line, then one line for each project with unsaved work. */
export function boxWorkLines(work: BoxWork, box: string): string[] {
  if (work.checked === 0) {
    return [`Unsaved work: no projects to check. Add projects to [box.${box}], or move a project to the box with ferry move.`];
  }
  if (work.projects.length === 0) return [`Unsaved work: none in ${plural(work.checked, "project")}`];
  return [
    `Unsaved work: ${work.projects.length} of ${plural(work.checked, "project")}, only on the box`,
    ...work.projects.map((project) => {
      const parts = [
        ...(project.changes > 0 ? [`${plural(project.changes, "changed file")}`] : []),
        ...project.unpushed.map((entry) => `${entry.branch} has ${plural(entry.commits, "commit")} that no remote has`),
      ];
      return `  ~/${project.path} (${project.branch ?? "detached HEAD"}): ${parts.join(", ")}`;
    }),
  ];
}
