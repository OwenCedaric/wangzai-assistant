#!/usr/bin/env bash
# Full frontend vitest run (all batches, continuing past failures); exits 1 when a
# test file fails that is not one of the recorded baseline failures.
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(cd "$root/frontend" && node "$root/tools/refactor/run-frontend-batches.mjs" 2>&1)"
echo "$out" | grep -E "^batch" | sed -E 's/\s+/ /g'
failed="$(echo "$out" | grep -E '^\s+FAIL' | sed -E 's/^\s+FAIL\s+//; s/:[0-9]+:[0-9]+$//' | sort -u)"
baseline="src/services/globalDialogMinimizationRules.test.js
src/services/orderSplitRelationIntegration.test.js
src/services/ozonSyncClient.test.js
src/services/purchaseCrossBorderReadRules.test.js
src/services/retiredPaidAnalyticsRules.test.js"
new="$(comm -13 <(echo "$baseline" | sort -u) <(echo "$failed") | sed '/^$/d')"
if [ -n "$new" ]; then printf 'NEW FRONTEND FAILURES:\n%s\n' "$new"; exit 1; fi
echo "frontend: no new failing files vs baseline"
