# Linux status bar

The menu bar app runs only on macOS. On Linux, a [waybar](https://github.com/Alexays/Waybar) custom module can show the same state. It reads `~/.ferry/status.json`, which `ferry watch` writes. Run `ferry watch install` first.

The module shows the number of items that need action. Its tooltip lists the items of each box, one short line for each item. A click opens a terminal and runs the fix command of the first item that has one.

## The status file

`ferry watch` writes the report of `ferry status --brief --json` to `~/.ferry/status.json` when it starts, every 5 minutes, and after each sync:

```json
{
  "schemaVersion": 1,
  "checkedAt": "2026-09-29T10:00:00.000Z",
  "boxes": [
    {
      "name": "box-a",
      "host": "user@box.example",
      "online": true,
      "error": null,
      "summary": null,
      "issues": [
        {
          "kind": "mcp-login",
          "name": "claude/linear",
          "state": "login-required",
          "summary": "claude/linear: login needed",
          "message": "claude/linear needs a login.",
          "command": "ferry auth claude --mcp linear --box box-a"
        }
      ],
      "resources": {
        "disk": { "totalKiB": 104857600, "freeKiB": 52428800 },
        "memory": { "totalKiB": 16777216, "availableKiB": 8388608 },
        "load": { "one": 0.5, "five": 0.4, "fifteen": 0.3, "cpus": 8 }
      }
    }
  ]
}
```

`summary` is a short title of at most 60 characters, such as `codex/node_repl: 5 env keys missing`. A long name loses its middle, which becomes `…`. `message` is the full text. A status file of Ferry 0.10.0 or earlier has no `summary`. `command` is `null` when a person must act on the box. An offline box has `online: false`, the reason in `error`, the reason in at most 60 characters in `summary`, no issues, and `resources: null`. Low disk or memory is an issue of the kind `resource`, so the script counts it.

## States

The script uses the same rules as the macOS app:

| Class | When | Text |
| --- | --- | --- |
| `missing` | `~/.ferry/status.json` does not exist or is not valid. | `?` |
| `stale` | `checkedAt` is more than 15 minutes old, so `ferry watch` does not run. | `?` |
| `needs-action` | One or more items need action. Each issue counts as one item, and so does each offline box. | the count |
| `ok` | No item needs action. | `0` |

The macOS app also counts disconnected `ferry tunnel --follow` tunnels. This script does not read the tunnel files.

## Script

Save the script as `~/.local/bin/ferry-waybar` and make it executable with `chmod +x ~/.local/bin/ferry-waybar`. It needs `jq` 1.6 or later.

Set `terminal` to your terminal and the option that runs a command. For example: `foot`, `kitty`, `alacritty -e`, `wezterm start --`, or `gnome-terminal --`. You can also set `FERRY_TERMINAL` in the environment of waybar.

```sh
#!/bin/sh
# Print the Ferry status as waybar JSON. With "fix", run the fix command of
# the first item in a terminal.
terminal=${FERRY_TERMINAL:-foot}

status="$HOME/.ferry/status.json"

if [ "$1" = fix ]; then
  command=$(jq -r 'first(.boxes[] | select(.online) | .issues[] | .command | strings) // empty' "$status" 2>/dev/null)
  [ -n "$command" ] || exit 0
  # The terminal stays open until Enter, so the operator can read the output.
  # shellcheck disable=SC2086 # terminal can hold a command and its options.
  exec $terminal sh -c 'eval "$1"; printf "\nPress Enter to close. "; read -r _' sh "$command"
fi

jq -c '
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  def ago($s): if $s < 3600 then "\($s / 60 | floor) min ago" else "\($s / 3600 | floor) h ago" end;
  select(.schemaVersion == 1 and (.boxes | type) == "array") |
  (.checkedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $checked |
  (now - $checked) as $age |
  ([.boxes[] | if .online then (.issues | length) else 1 end] | add // 0) as $count |
  ([.boxes[] |
    "\(.name | esc)  \(if .online then "ONLINE" else "OFFLINE" end)",
    (if .online then (.issues[] | "  \(.summary // .message | esc)") else "  \(.summary // .error // "" | esc)" end)
  ] | join("\n")) as $items |
  if $age > 900 then
    {text: "?", class: "stale", tooltip: "ferry watch is not running. Last check \(ago($age)).\n\n\($items)"}
  elif $count == 0 then
    {text: "0", class: "ok", tooltip: "All clear. Checked \(ago($age)).\n\n\($items)"}
  else
    {text: "\($count)", class: "needs-action",
     tooltip: "\($count) \(if $count == 1 then "item needs" else "items need" end) action. Checked \(ago($age)).\n\n\($items)"}
  end
' "$status" 2>/dev/null | grep . ||
  printf '%s\n' '{"text":"?","class":"missing","tooltip":"No Ferry status. Run ferry watch install."}'
```

## Waybar config

Add the module to `~/.config/waybar/config.jsonc`, and add `"custom/ferry"` to one of `modules-left`, `modules-center`, or `modules-right`:

```jsonc
"custom/ferry": {
  "exec": "~/.local/bin/ferry-waybar",
  "return-type": "json",
  "interval": 30,
  "format": "ferry {}",
  "on-click": "~/.local/bin/ferry-waybar fix"
}
```

The script only reads a file, so a 30-second interval costs little. The macOS app reads the file at the same interval.

To color the states, add rules to `~/.config/waybar/style.css`:

```css
#custom-ferry.needs-action { color: #e5a50a; }
#custom-ferry.stale,
#custom-ferry.missing { color: #9a9996; }
```
