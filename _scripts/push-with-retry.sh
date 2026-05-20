#!/usr/bin/env bash
# Push the current branch, retrying on non-fast-forward by rebasing onto
# the new remote tip. For composite actions that commit + push from a
# workflow that may race with other workflows (or a human) pushing to
# the same branch. The caller must already have made the commit(s) to
# push and configured git user identity.
#
# Env: MAX_ATTEMPTS (default 5) — cap on retry attempts.

set -euo pipefail

max_attempts="${MAX_ATTEMPTS:-5}"
attempt=1

while :; do
  push_output=$(git push 2>&1) && rc=0 || rc=$?
  printf '%s\n' "$push_output"
  if [ "$rc" -eq 0 ]; then
    exit 0
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "::error::push failed after $max_attempts attempts"
    exit 1
  fi
  if ! grep -qE '(rejected|non-fast-forward|fetch first)' <<< "$push_output"; then
    echo "::error::push failed for a non-race reason"
    exit 1
  fi
  echo "Push rejected (likely concurrent push); rebasing and retrying (attempt $attempt/$max_attempts)..."
  git pull --rebase --autostash
  attempt=$((attempt + 1))
  sleep 2
done
