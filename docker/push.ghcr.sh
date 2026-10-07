#!/bin/bash
# Build + push image to GitHub Container Registry (ghcr.io) — run manually, not CI.
#
# One-time setup:
#   1) Create a PAT (classic) at https://github.com/settings/tokens with scope: write:packages, read:packages
#   2) export GHCR_USER=<github-username>
#      export CR_PAT=<token>
#   (or install the gh CLI: the script fetches the token automatically via `gh auth token`)
#
# Usage:
#   ./docker/push.ghcr.sh                 # tag latest, Dockerfile.single-tenant, amd64
#   ./docker/push.ghcr.sh v1.0.3          # tag v1.0.3
#   DOCKERFILE=Dockerfile ./docker/push.ghcr.sh
#   PLATFORM=linux/amd64,linux/arm64 ./docker/push.ghcr.sh   # multi-arch (slow, requires buildx)

set -euo pipefail

cd "$(dirname "$0")/.."          # always build from the repo root

IMAGE="${IMAGE:-ghcr.io/mangoads-hq/backend-deploy-tenant}"
TAG="${1:-latest}"
DOCKERFILE="${DOCKERFILE:-Dockerfile.single-tenant}"
PLATFORM="${PLATFORM:-linux/amd64}"

# ── Login ────────────────────────────────────────────────────────────────────
if [ -n "${CR_PAT:-}" ]; then
  echo "$CR_PAT" | docker login ghcr.io -u "${GHCR_USER:?Cần export GHCR_USER=<github-username>}" --password-stdin
elif command -v gh >/dev/null 2>&1; then
  # gh token must have scope write:packages, otherwise docker login still works but the push will be
  # "denied: permission_denied: The token provided does not match expected scopes"
  if ! gh auth status 2>&1 | grep -q 'write:packages'; then
    echo "!! Token gh đang thiếu scope write:packages. Chạy:" >&2
    echo "     gh auth refresh -h github.com -s write:packages,read:packages" >&2
    echo "   rồi 'docker logout ghcr.io' và chạy lại. (Hoặc export CR_PAT=<classic PAT>)" >&2
    exit 1
  fi
  gh auth token | docker login ghcr.io -u "${GHCR_USER:-$(gh api user -q .login)}" --password-stdin
else
  echo "Chưa có CR_PAT và cũng không có gh CLI → tự chạy: docker login ghcr.io" >&2
  docker login ghcr.io
fi

# ── Build + push ─────────────────────────────────────────────────────────────
echo "Building $IMAGE:$TAG  (file=$DOCKERFILE, platform=$PLATFORM)"

if [[ "$PLATFORM" == *,* ]]; then
  # multi-arch: buildx requires pushing directly; it cannot load back to local
  docker buildx build \
    --platform "$PLATFORM" \
    --label org.opencontainers.image.source=https://github.com/MangoAds-HQ/backend-deploy-tenant \
    -t "$IMAGE:$TAG" \
    -f "$DOCKERFILE" . \
    --push
else
  docker build \
    --platform "$PLATFORM" \
    --label org.opencontainers.image.source=https://github.com/MangoAds-HQ/backend-deploy-tenant \
    -t "$IMAGE:$TAG" \
    -f "$DOCKERFILE" .
  docker push "$IMAGE:$TAG"
fi

echo "Done → $IMAGE:$TAG"
echo "Pull: docker pull $IMAGE:$TAG"
echo "Package mặc định là PRIVATE. Muốn public: GitHub → Packages → backend-deploy-tenant → Package settings → Change visibility."
