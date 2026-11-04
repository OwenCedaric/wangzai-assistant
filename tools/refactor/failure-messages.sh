#!/usr/bin/env bash
# Prints normalized failure messages of one node:test file (durations/paths stripped),
# so already-failing tests can be compared before/after a refactor step.
cd "$(dirname "$0")/../../local-api" && node --test --test-reporter=spec "$1" 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | sed -E 's/ \([0-9.]+ms\)//; s#file:///[^ )]+##g; s/:[0-9]+:[0-9]+//g' \
  | grep -vE "^\s+at |duration_ms|^ℹ"
