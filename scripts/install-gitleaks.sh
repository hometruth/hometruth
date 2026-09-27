#!/usr/bin/env bash
# CI helper: pinned release, archive verified against that release's checksums.
set -euo pipefail
version=8.30.1
destination="${RUNNER_TEMP:?This helper runs in GitHub Actions}/hometruth-gitleaks"
mkdir -p "$destination"
cd "$destination"
base="https://github.com/gitleaks/gitleaks/releases/download/v${version}"
archive="gitleaks_${version}_linux_x64.tar.gz"
curl --fail --silent --show-error --location "$base/$archive" --output "$archive"
curl --fail --silent --show-error --location "$base/gitleaks_${version}_checksums.txt" --output checksums.txt
grep "  $archive\$" checksums.txt > selected-checksum.txt
sha256sum --check selected-checksum.txt
tar -xzf "$archive" gitleaks
chmod 755 gitleaks
printf '%s\n' "$destination" >> "${GITHUB_PATH:?}"
