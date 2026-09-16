#!/usr/bin/env bash
set -euo pipefail

# gitleaks-action intentionally rejects workflow_run and workflow_dispatch.
# Deploys still need a secret scan, so install the pinned upstream binary and
# verify its archive before scanning the checked-out deploy tree. Pull-request
# and main-branch history is already covered by CI.
readonly GITLEAKS_VERSION="8.24.3"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    readonly GITLEAKS_PLATFORM="linux_x64"
    readonly GITLEAKS_SHA256="9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c"
    ;;
  Darwin:arm64)
    readonly GITLEAKS_PLATFORM="darwin_arm64"
    readonly GITLEAKS_SHA256="b90f13bb8c90ab72083d9b0c842e39dafb82c0e5c3f872f407366b7a58909013"
    ;;
  *)
    echo "unsupported gitleaks platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac
readonly GITLEAKS_ARCHIVE="gitleaks_${GITLEAKS_VERSION}_${GITLEAKS_PLATFORM}.tar.gz"
readonly GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ARCHIVE}"
readonly GITLEAKS_DIR="${RUNNER_TEMP:-/tmp}/hermes-gitleaks-${GITLEAKS_VERSION}"
readonly SCAN_DIR="${RUNNER_TEMP:-/tmp}/hermes-gitleaks-source-$$"

mkdir -p "$GITLEAKS_DIR"
curl --fail --silent --show-error --location "$GITLEAKS_URL" --output "$GITLEAKS_DIR/$GITLEAKS_ARCHIVE"
actual_sha256="$(shasum -a 256 "$GITLEAKS_DIR/$GITLEAKS_ARCHIVE" | awk '{print $1}')"
if [[ "$actual_sha256" != "$GITLEAKS_SHA256" ]]; then
  echo "gitleaks archive checksum did not match" >&2
  exit 1
fi
tar -xzf "$GITLEAKS_DIR/$GITLEAKS_ARCHIVE" -C "$GITLEAKS_DIR" gitleaks

# Scan only files tracked by the exact checked-out commit. Dependency installs
# can contain credentials in third-party fixtures, but they are not deploy
# source and are already governed by the lockfile reviewed in CI.
mkdir -p "$SCAN_DIR"
git archive HEAD | tar -x -C "$SCAN_DIR"
"$GITLEAKS_DIR/gitleaks" detect --source "$SCAN_DIR" --no-git --redact --config .gitleaks.toml
