#!/bin/sh
# Install Ferry from a GitHub release. Run the script again to update Ferry.
#
#   curl -fsSL https://raw.githubusercontent.com/dlhck/ferry/main/install.sh | sh
#
# Environment variables:
#   FERRY_VERSION        Release tag to install, for example v0.2.0. Default: the latest release.
#   FERRY_INSTALL_DIR    Directory for the ferry executable. Default: ~/.local/bin.
#   FERRY_DOWNLOAD_BASE  Base URL of the releases. Default: https://github.com/dlhck/ferry/releases.
#   FERRY_SKIP_CHECKSUM  Set to 1 to install a release that has no SHA256SUMS file (v0.1.1 and earlier).
#                        The script then does not verify the download.
#
# A release is visible before the release workflow attaches its files. The script stops when
# the release does not have its files yet. It does not install an older release in its place.

set -eu

# All work is in main, so a partial download of this script does nothing.
main() {
  version=${FERRY_VERSION:-}
  install_dir=${FERRY_INSTALL_DIR:-$HOME/.local/bin}
  base=${FERRY_DOWNLOAD_BASE:-https://github.com/dlhck/ferry/releases}

  os=$(uname -s)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "Ferry does not support the operating system $os. Ferry runs on macOS and Linux." ;;
  esac

  arch=$(uname -m)
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "Ferry does not support the CPU architecture $arch. Ferry runs on arm64 and x64." ;;
  esac

  asset="ferry-$os-$arch"
  if [ -n "$version" ]; then
    url="$base/download/$version"
    release="Ferry ${version#v}"
  else
    url="$base/latest/download"
    release="The latest Ferry release"
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ferry-install.XXXXXX")
  staged=
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  # SHA256SUMS first: a release without it does not have its files yet, so the script stops
  # before it downloads a binary.
  expected=
  if [ "${FERRY_SKIP_CHECKSUM:-}" = 1 ]; then
    echo "Warning: FERRY_SKIP_CHECKSUM=1. The script does not verify the download." >&2
  else
    download "$url/SHA256SUMS" "$tmp/SHA256SUMS" ||
      fail "$release is not ready for download. The release is still in its build. Try again in some minutes.
If the release is not new: $url has no SHA256SUMS. Make sure that the release exists. Releases v0.1.1 and earlier have no SHA256SUMS. To install such a release without a checksum check, set FERRY_SKIP_CHECKSUM=1."
    expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")
    [ -n "$expected" ] || fail "SHA256SUMS has no checksum for $asset."
  fi

  echo "Downloading $asset from $url"
  download "$url/$asset" "$tmp/$asset" ||
    fail "Cannot download $url/$asset. If the release is new, it is still in its build. Try again in some minutes."

  if [ -n "$expected" ]; then
    actual=$(sha256 "$tmp/$asset")
    [ "$actual" = "$expected" ] || fail "Checksum mismatch for $asset. Expected $expected, got $actual."
  fi

  # The darwin binaries have an ad-hoc signature. Any change to the file makes the signature
  # not valid, so the script only sets the mode and removes the quarantine attribute.
  chmod 755 "$tmp/$asset"
  if [ "$os" = darwin ] && xattr -p com.apple.quarantine "$tmp/$asset" >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$tmp/$asset"
  fi

  # The temporary directory can be on a different file system. Copy the file into the install
  # directory first, so that the last mv is a rename and replaces an existing binary atomically.
  mkdir -p "$install_dir"
  staged="$install_dir/.ferry.$$"
  cp "$tmp/$asset" "$staged"
  mv -f "$staged" "$install_dir/ferry"
  staged=

  installed=$("$install_dir/ferry" --version) || fail "$install_dir/ferry does not run."
  echo "Installed ferry $installed to $install_dir/ferry"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      echo
      echo "$install_dir is not on your PATH. Add this line to your shell profile, for example ~/.zshrc or ~/.bashrc:"
      echo
      echo "  export PATH=\"$install_dir:\$PATH\""
      ;;
  esac
}

cleanup() {
  rm -rf "$tmp"
  if [ -n "$staged" ]; then rm -f "$staged"; fi
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "Ferry needs curl or wget to download the release."
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "Ferry needs sha256sum or shasum to verify the download."
  fi
}

main "$@"
