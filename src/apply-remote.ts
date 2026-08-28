/** Execute generic Apply inspection and mutation requests through Link. */

import { dirname, posix } from "node:path";
import type { LinkResult } from "./link.ts";

export type InspectedPath =
  | { readonly kind: "missing" }
  | { readonly kind: "empty-directory" }
  | { readonly kind: "other" }
  | {
      readonly kind: "symlink";
      readonly link: string;
      readonly resolvedLink: string;
    };

export type InspectedEntry = {
  readonly name: string;
  readonly state: InspectedPath;
};

export type TargetInspection = {
  readonly skillNames: readonly string[];
  readonly instructionExists: boolean;
  readonly paths: ReadonlyMap<string, InspectedPath>;
  readonly roots: ReadonlyMap<string, readonly InspectedEntry[]>;
};

export type TargetInspectionRequest = {
  readonly storeSkills: string;
  readonly instructions: string;
  readonly targetRoots: readonly string[];
  readonly instructionTargets: readonly string[];
  readonly backupSuffix: string;
};

export type TargetAction =
  | {
      readonly kind: "create-symlink" | "repair-symlink";
      readonly path: string;
      readonly target: string;
    }
  | {
      readonly kind: "backup-and-link";
      readonly path: string;
      readonly target: string;
      readonly backupPath: string;
    }
  | {
      readonly kind: "delete-managed-name";
      readonly path: string;
      readonly expectedLink: string;
    };

export type RemoteApplyLink = {
  run(command: string): Promise<LinkResult>;
};

export class RemoteTargetError extends Error {
  constructor(
    message: string,
    readonly actionIndex?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteTargetError";
  }
}

export async function inspectRemoteTarget(
  request: TargetInspectionRequest,
  link: RemoteApplyLink,
): Promise<TargetInspection> {
  const result = await link.run(inspectionCommand(request));
  if (!result.ok) throw new RemoteTargetError(result.error.message);
  return parseInspection(result.stdout);
}

export async function commitRemoteTarget(
  actions: readonly TargetAction[],
  link: RemoteApplyLink,
): Promise<void> {
  if (actions.length === 0) return;
  const result = await link.run(commitCommand(actions));
  if (result.ok) return;
  const match = result.error.message.match(/(?:^|\n)F\t(\d+)(?:\n|$)/);
  const actionIndex = match ? Number.parseInt(match[1]!, 10) : undefined;
  throw new RemoteTargetError(result.error.message, actionIndex);
}

const INSPECTION_WORKER = String.raw`
set -f
hex() { LC_ALL=C od -An -tx1 | tr -d ' \n'; }
state() {
  state_path=$1
  if [ -L "$state_path" ]; then
    state_link=$(readlink "$state_path") || return 1
    printf 'L\t%s' "$(printf '%s' "$state_link" | hex)"
  elif [ -d "$state_path" ]; then
    state_first=$(find "$state_path"/. ! -name . -prune -print -quit 2>/dev/null) || return 1
    if [ -z "$state_first" ]; then printf 'D\t'; else printf 'O\t'; fi
  elif [ -e "$state_path" ]; then
    printf 'O\t'
  else
    printf 'M\t'
  fi
}
mode=$1
shift
case "$mode" in
  source)
    for source_path do
      source_name=$(basename "$source_path") || exit 1
      printf 'S\t%s\n' "$(printf '%s' "$source_name" | hex)"
    done
    ;;
  entries)
    entry_root=$1
    shift
    for entry_path do
      entry_name=$(basename "$entry_path") || exit 1
      printf 'E\t%s\t%s\t' \
        "$(printf '%s' "$entry_root" | hex)" \
        "$(printf '%s' "$entry_name" | hex)"
      state "$entry_path" || exit 1
      printf '\n'
    done
    ;;
  candidates)
    candidate_root=$1
    candidate_suffix=$2
    shift 2
    for source_path do
      candidate_name=$(basename "$source_path") || exit 1
      candidate_path=$candidate_root/$candidate_name
      candidate_backup=$candidate_path$candidate_suffix
      printf 'P\t%s\t' "$(printf '%s' "$candidate_path" | hex)"
      state "$candidate_path" || exit 1
      printf '\nP\t%s\t' "$(printf '%s' "$candidate_backup" | hex)"
      state "$candidate_backup" || exit 1
      printf '\n'
    done
    ;;
  direct)
    direct_suffix=$1
    shift
    for direct_path do
      direct_backup=$direct_path$direct_suffix
      printf 'P\t%s\t' "$(printf '%s' "$direct_path" | hex)"
      state "$direct_path" || exit 1
      printf '\nP\t%s\t' "$(printf '%s' "$direct_backup" | hex)"
      state "$direct_backup" || exit 1
      printf '\n'
    done
    ;;
esac
`;

const INSPECTION_SCRIPT = String.raw`
set -f
worker=$1
store_skills=$2
instructions=$3
backup_suffix=$4
root_count=$5
shift 5
find "$store_skills"/. ! -name . -prune -type d -exec sh -c "$worker" sh source {} + || exit 1
if [ -e "$instructions" ]; then
  printf 'I\t1\n'
else
  printf 'I\t0\n'
fi
root_index=0
while [ "$root_index" -lt "$root_count" ]; do
  target_root=$1
  shift
  if [ -d "$target_root" ]; then
    find "$target_root"/. ! -name . -prune \
      -exec sh -c "$worker" sh entries "$target_root" {} + || exit 1
  fi
  find "$store_skills"/. ! -name . -prune -type d \
    -exec sh -c "$worker" sh candidates "$target_root" "$backup_suffix" {} + || exit 1
  root_index=$((root_index + 1))
done
direct_count=$1
shift
if [ "$direct_count" -gt 0 ]; then
  sh -c "$worker" sh direct "$backup_suffix" "$@" || exit 1
fi
`;

const COMMIT_SCRIPT = String.raw`
set -f
index=0
while [ "$#" -gt 0 ]; do
  kind=$1
  action_path=$2
  action_target=$3
  action_extra=$4
  shift 4
  case "$kind" in
    create-symlink)
      action_parent=$(dirname "$action_path")
      mkdir -p "$action_parent" && ln -s "$action_target" "$action_path"
      ;;
    repair-symlink)
      if [ -L "$action_path" ]; then
        unlink "$action_path"
      elif [ -d "$action_path" ]; then
        rmdir "$action_path"
      else
        false
      fi && ln -s "$action_target" "$action_path"
      ;;
    backup-and-link)
      mv "$action_path" "$action_extra" && ln -s "$action_target" "$action_path"
      ;;
    delete-managed-name)
      [ -L "$action_path" ] && [ "$(readlink "$action_path")" = "$action_extra" ] && \
        unlink "$action_path"
      ;;
    *)
      false
      ;;
  esac
  if [ "$?" -ne 0 ]; then
    printf '\nF\t%s\n' "$index" >&2
    exit 1
  fi
  index=$((index + 1))
done
`;

function inspectionCommand(request: TargetInspectionRequest): string {
  const arguments_ = [
    INSPECTION_WORKER,
    request.storeSkills,
    request.instructions,
    request.backupSuffix,
    String(request.targetRoots.length),
    ...request.targetRoots,
    String(request.instructionTargets.length),
    ...request.instructionTargets,
  ];
  return shellCommand(INSPECTION_SCRIPT, arguments_);
}

function commitCommand(actions: readonly TargetAction[]): string {
  const arguments_: string[] = [];
  for (const action of actions) {
    switch (action.kind) {
      case "create-symlink":
      case "repair-symlink":
        arguments_.push(action.kind, action.path, action.target, "");
        break;
      case "backup-and-link":
        arguments_.push(action.kind, action.path, action.target, action.backupPath);
        break;
      case "delete-managed-name":
        arguments_.push(action.kind, action.path, "", action.expectedLink);
        break;
    }
  }
  return shellCommand(COMMIT_SCRIPT, arguments_);
}

function shellCommand(script: string, arguments_: readonly string[]): string {
  return ["sh", "-c", quoteShell(script), "sh", ...arguments_.map(quoteShell)].join(" ");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseInspection(stdout: string): TargetInspection {
  const skillNames: string[] = [];
  let instructionExists = false;
  const paths = new Map<string, InspectedPath>();
  const roots = new Map<string, InspectedEntry[]>();

  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    switch (fields[0]) {
      case "S":
        skillNames.push(fromHex(required(fields[1])));
        break;
      case "I":
        instructionExists = fields[1] === "1";
        break;
      case "P": {
        const path = fromHex(required(fields[1]));
        paths.set(path, parsePath(path, required(fields[2]), fields[3] ?? ""));
        break;
      }
      case "E": {
        const root = fromHex(required(fields[1]));
        const name = fromHex(required(fields[2]));
        const path = posix.join(root, name);
        const entries = roots.get(root) ?? [];
        const state = parsePath(path, required(fields[3]), fields[4] ?? "");
        entries.push({ name, state });
        roots.set(root, entries);
        paths.set(path, state);
        break;
      }
      default:
        throw new RemoteTargetError("the box returned invalid Apply inspection data");
    }
  }

  skillNames.sort(compare);
  for (const entries of roots.values()) entries.sort((a, b) => compare(a.name, b.name));
  return { skillNames, instructionExists, paths, roots };
}

function parsePath(path: string, kind: string, linkHex: string): InspectedPath {
  switch (kind) {
    case "M":
      return { kind: "missing" };
    case "D":
      return { kind: "empty-directory" };
    case "O":
      return { kind: "other" };
    case "L": {
      const link = fromHex(linkHex);
      return { kind: "symlink", link, resolvedLink: posix.resolve(dirname(path), link) };
    }
    default:
      throw new RemoteTargetError("the box returned an invalid Apply path state");
  }
}

function fromHex(value: string): string {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) {
    throw new RemoteTargetError("the box returned invalid Apply text data");
  }
  return Buffer.from(value, "hex").toString("utf8");
}

function required(value: string | undefined): string {
  if (value === undefined) throw new RemoteTargetError("the box returned incomplete Apply data");
  return value;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
