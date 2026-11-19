#!/usr/bin/env bash
# Run each test file in its own tsx process to avoid node:test runner hang.
set -euo pipefail
PASS=0

TEST_TIMEOUT="${TEST_TIMEOUT:-120}"
if [[ ! "$TEST_TIMEOUT" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Invalid TEST_TIMEOUT: $TEST_TIMEOUT (expected a non-negative number of seconds)" >&2
  exit 2
fi

TIMEOUT_BIN=()
if [[ ! "$TEST_TIMEOUT" =~ ^0+([.]0+)?$ ]]; then
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN=(timeout)
  elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN=(gtimeout)
  fi
fi

# Prefer the checkout's local tsx shim. Going through `npx` for every file
# means ~50 npm startups; under the process pressure of a long suite npm can
# fail with "Could not determine Node.js install directory" (observed on
# Windows). The local shim avoids npm entirely. Fall back to `npx tsx` only
# when there is no local install (e.g. run straight from a fresh clone).
if [[ -x node_modules/.bin/tsx ]]; then
  TSX_RUNNER=(node_modules/.bin/tsx)
else
  TSX_RUNNER=(npx tsx)
fi

run_test_file() {
  local file="$1"
  if ((${#TIMEOUT_BIN[@]} > 0)); then
    "${TIMEOUT_BIN[@]}" --kill-after=5s "$TEST_TIMEOUT" "${TSX_RUNNER[@]}" --test "$file"
  else
    "${TSX_RUNNER[@]}" --test "$file"
  fi
}

for f in $(find tests -name '*.test.ts' | sort); do
  echo "--- $f ---"
  if run_test_file "$f"; then
    PASS=$((PASS + 1))
  else
    rc=$?
    if [[ "$rc" -eq 124 && ${#TIMEOUT_BIN[@]} -gt 0 ]]; then
      echo "TIMEOUT (>${TEST_TIMEOUT}s): $f"
    else
      echo "FAILED (exit $rc): $f"
    fi
    exit 1
  fi
done

echo "All $PASS test files passed"
