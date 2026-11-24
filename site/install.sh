#!/bin/sh
# Installs Cleat: bun if it is missing, then cleat itself, then its setup.
#   curl -fsSL https://cleat.kaitila.dev/install.sh | sh
# The repo's one shell script (D0047): it only gets bun onto the machine; everything after that is
# TypeScript (cleat setup). POSIX sh, so it runs under the sh of macOS, Linux and WSL alike.
set -eu

say() { printf '%s\n' "$*"; }
fail() {
  printf 'cleat install: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) fail "run this on macOS or Linux, or on Windows in a WSL terminal (wsl --install)" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is needed"

# Where bun's installer puts bun; on the PATH for the rest of this script either way.
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
PATH="$BUN_INSTALL/bin:$PATH"
export BUN_INSTALL PATH

# The terminal, for what asks the person something: this script's own input is the pipe from curl.
tty_ok() { (exec </dev/tty) 2>/dev/null; }

if ! command -v bun >/dev/null 2>&1; then
  if ! command -v unzip >/dev/null 2>&1; then
    # bun's installer unpacks a zip. Debian and Ubuntu (WSL's default) can get unzip here.
    if command -v apt-get >/dev/null 2>&1 && tty_ok; then
      say "Installing unzip, which bun's installer needs (sudo may ask for your password)"
      sudo apt-get install -y unzip </dev/tty || fail "unzip could not be installed: install it, then run this again"
    else
      fail "bun's installer needs unzip: install it, then run this again"
    fi
  fi
  say "Installing bun"
  curl -fsSL https://bun.sh/install | bash
fi

say "Installing cleat"
bun install -g github:kaitila/cleat

# Setup asks its questions in the terminal; without one it takes every default.
if tty_ok; then
  cleat setup </dev/tty
else
  cleat setup --yes
fi

say ""
say "Cleat is installed. If this terminal doesn't know the cleat command yet, open a new one."
