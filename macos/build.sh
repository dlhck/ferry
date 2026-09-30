#!/bin/sh
# Build the Ferry menu bar app on macOS: a universal release binary (arm64 and x86_64),
# "Ferry Menu Bar.app" with its icon and an ad-hoc signature, and the release asset
# ferry-menubar-macos.zip.
#
#   macos/build.sh [output directory]
#
# The default output directory is dist/ in the repository. The app version is FERRY_VERSION,
# else the version of package.json. Install the result with ferry menubar install --app <path>.

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
package="$root/macos/FerryMenuBar"
out=${1:-$root/dist}
version=${FERRY_VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/package.json")}
[ -n "$version" ] || { echo "Error: cannot read the version from package.json." >&2; exit 1; }

swift build --package-path "$package" -c release --arch arm64 --arch x86_64
bin=$(swift build --package-path "$package" -c release --arch arm64 --arch x86_64 --show-bin-path)
lipo "$bin/FerryMenuBar" -verify_arch arm64 x86_64

app="$out/Ferry Menu Bar.app"
zip="$out/ferry-menubar-macos.zip"
rm -rf "$app" "$zip"
mkdir -p "$app/Contents/MacOS"
cp "$bin/FerryMenuBar" "$app/Contents/MacOS/FerryMenuBar"

# The app icon. macos/AppIcon.png is docs/favicon.svg at 824 px in the middle of a transparent
# 1024 px image, which is the icon grid of macOS. An icon set has each size at 1x and at 2x.
iconset="$out/AppIcon.iconset"
rm -rf "$iconset"
mkdir -p "$iconset" "$app/Contents/Resources"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/macos/AppIcon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$root/macos/AppIcon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
rm -rf "$iconset"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.ferry.menubar</string>
  <key>CFBundleName</key>
  <string>Ferry Menu Bar</string>
  <key>CFBundleExecutable</key>
  <string>FerryMenuBar</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

# No Developer ID: an ad-hoc signature. ferry menubar install downloads without a quarantine flag.
codesign --force --sign - "$app"
codesign --verify --strict "$app"
ditto -c -k --keepParent "$app" "$zip"
echo "Built $app and $zip (version $version)"
