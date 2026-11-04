#!/usr/bin/env bash
# Freeze checks must keep their baseline violation counts; architecture guard and
# desktop protected-boundary tests must stay green. Exit 1 on any regression.
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
status=0
declare -A expected=(
  [check:profit-freeze]=12 [check:profit-review-freeze]=0 [check:product-selection-freeze]=0
  [check:purchase-pdd-route-freeze]=0 [check:data-analysis-insight-freeze]=0
  [check:data-analysis-market-capture-freeze]=5 [check:product-image-oss-freeze]=27
  [check:follow-seller-scheme1-freeze]=9
)
cd "$root/frontend"
for check in "${!expected[@]}"; do
  actual="$(npm run -s "$check" 2>&1 | head -1 | grep -oE 'violations=[0-9]+' | cut -d= -f2)"
  if [ "$actual" != "${expected[$check]}" ]; then echo "FREEZE $check: ${actual:-?} (baseline ${expected[$check]})"; status=1; fi
done
npm run -s check:architecture 2>&1 | grep -q "cycles=0, new=0, product-boundary=0" || { echo "ARCHITECTURE guard regressed"; status=1; }
(cd "$root/desktop" && npm run -s test:protected-boundary 2>&1 | grep -q "^ℹ fail 0") || { echo "DESKTOP protected-boundary failed"; status=1; }
# Tests in other projects that read local-api source text: moving code can break them.
# (retiredPaidAnalyticsRules.test.js is a known baseline failure and is not gated here.)
(cd "$root/frontend" && npm exec --no -- vitest run \
  src/services/notificationCenterRules.test.js src/services/ozonPushFullLinkageRules.test.js \
  src/services/profileMaintenanceCommandRules.test.js src/services/salesOrderFullOwnerRead.test.js \
  src/features/settings/purchaseAccountLocalApiRules.test.js src/services/modelApiSettingsLocalFirstRules.test.js \
  src/services/paidPromotionApiMigrationRules.test.js \
  2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -qE "Tests +[0-9]+ passed \([0-9]+\)") \
  || { echo "FRONTEND local-api source guards failed"; status=1; }
(cd "$root/frontend" && node --test scripts/product-image-oss-freeze.node.mjs scripts/profit-future-shop-paths.node.mjs \
  scripts/profit-migration-repair.node.mjs scripts/scan-secrets.test.mjs 2>&1 | grep -q "^ℹ fail 0") \
  || { echo "FRONTEND node source guards failed"; status=1; }
(cd "$root/desktop" && node --test src/runtime/*.test.js src/licensing/*.test.js src/protocol/*.test.js \
  scripts/protected-compute-semantic-audit.test.mjs scripts/shared-catalog-package-smoke-proof.test.mjs \
  scripts/real-sku-evidence-release-gate.test.mjs \
  2>&1 | grep -q "^ℹ fail 0") \
  || { echo "DESKTOP runtime/source guards failed"; status=1; }
[ $status -eq 0 ] && echo "gates: freeze counts unchanged, architecture clean, protected-boundary green"
exit $status
