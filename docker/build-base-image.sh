#!/bin/bash
set -e

docker login registry.gitlab.com

docker buildx build --platform linux/amd64,linux/arm64 \
  -t registry.gitlab.com/mangoads/mangox-backend-api/node20-alpine:latest \
  -f Dockerfile.base . \
  --push
