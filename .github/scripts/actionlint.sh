#!/usr/bin/env bash
set -euo pipefail

readonly ACTIONLINT_VERSION="1.7.7"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    readonly ACTIONLINT_PLATFORM="linux_amd64"
    readonly ACTIONLINT_SHA256="023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757"
    ;;
  Darwin:arm64)
    readonly ACTIONLINT_PLATFORM="darwin_arm64"
    readonly ACTIONLINT_SHA256="2693315b9093aeacb4ebd91a993fea54fc215057bf0da2659056b4bc033873db"
    ;;
  *)
    echo "unsupported actionlint platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

readonly ACTIONLINT_ARCHIVE="actionlint_${ACTIONLINT_VERSION}_${ACTIONLINT_PLATFORM}.tar.gz"
readonly ACTIONLINT_URL="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${ACTIONLINT_ARCHIVE}"
readonly ACTIONLINT_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hermes-actionlint-${ACTIONLINT_VERSION}"

mkdir -p "$ACTIONLINT_DIR"
curl --fail --silent --show-error --location "$ACTIONLINT_URL" --output "$ACTIONLINT_DIR/$ACTIONLINT_ARCHIVE"
actual_sha256="$(shasum -a 256 "$ACTIONLINT_DIR/$ACTIONLINT_ARCHIVE" | awk '{print $1}')"
if [[ "$actual_sha256" != "$ACTIONLINT_SHA256" ]]; then
  echo "actionlint archive checksum did not match" >&2
  exit 1
fi
tar -xzf "$ACTIONLINT_DIR/$ACTIONLINT_ARCHIVE" -C "$ACTIONLINT_DIR" actionlint
"$ACTIONLINT_DIR/actionlint" -color "$@"
