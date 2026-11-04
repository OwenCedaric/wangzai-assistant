#!/usr/bin/env bash
# Runs the full local-api suite and diffs failures against the recorded baseline.
# Exit 1 when any test fails that is not in the baseline.
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
log="$(mktemp)"
(cd "$root/local-api" && node --test --test-reporter=spec 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "$log")
grep -E "^ℹ (tests|pass|fail)" "$log" | tr '\n' ' '; echo
current="$(grep -E '^\s*✖ ' "$log" | grep -v 'failing tests:' | sed -E 's/^\s+//; s/ \([0-9.]+ms\)//' | sort -u)"
baseline="$(sed -E 's/^\s+//' "$root/tools/refactor/baseline/local-api-failures.txt" | sort -u)"
new="$(comm -13 <(echo "$baseline") <(echo "$current") | sed '/^$/d')"
fixed="$(comm -23 <(echo "$baseline") <(echo "$current") | sed '/^$/d')"
[ -n "$fixed" ] && printf 'baseline failures now passing:\n%s\n' "$fixed"
if [ -n "$new" ]; then printf 'NEW FAILURES:\n%s\n' "$new"; exit 1; fi
echo "no new failures vs baseline"
