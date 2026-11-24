#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Flutter analyze: identidade federada"
dart analyze \
  "$ROOT_DIR/lib/navigation/app_router.dart" \
  "$ROOT_DIR/lib/features/account_context/domain/account_context_guards.dart" \
  "$ROOT_DIR/lib/features/identity/data/federated_identity_repository_impl.dart" \
  "$ROOT_DIR/test/features/identity/federated_identity_widgets_test.dart" \
  "$ROOT_DIR/test/navigation/app_router_identity_flags_test.dart"

echo "==> Flutter tests: identidade federada"
flutter test --reporter expanded \
  "$ROOT_DIR/test/features/identity/federated_identity_widgets_test.dart" \
  "$ROOT_DIR/test/navigation/app_router_identity_flags_test.dart"

echo "==> Functions build"
(cd "$ROOT_DIR/functions" && npm run build)

echo "==> Functions tests: identidade federada"
(cd "$ROOT_DIR/functions" && npm run test:identity)

echo "==> Firestore rules tests: identidade federada"
(cd "$ROOT_DIR/functions" && npm run test:rules)

echo "Pronto. A suíte da identidade federada passou."
