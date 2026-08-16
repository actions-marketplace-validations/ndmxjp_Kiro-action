#!/usr/bin/env bash
#
# Hardened `git push` wrapper.
#
# The agent is granted `shell` access to this script instead of to `git push`
# directly. Allowing `git push` with arbitrary arguments is remote code
# execution: `git push --receive-pack='sh -c ...' ext::sh origin` runs a shell.
# (Same class of issue as HackerOne #3556799 against the upstream action.)
#
# This wrapper accepts exactly: git-push.sh origin <branch|HEAD>
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: git-push.sh origin <branch>" >&2
  exit 2
fi

for arg in "$@"; do
  case "$arg" in
    -*)
      echo "git-push.sh: options are not allowed: $arg" >&2
      exit 2
      ;;
  esac
done

REMOTE="$1"
REF="$2"

if [ "$REMOTE" != "origin" ]; then
  echo "git-push.sh: only the 'origin' remote is allowed" >&2
  exit 2
fi

if [ "$REF" != "HEAD" ]; then
  if ! git check-ref-format --branch "$REF" >/dev/null 2>&1; then
    echo "git-push.sh: invalid branch name: $REF" >&2
    exit 2
  fi
fi

exec git push origin "$REF"
