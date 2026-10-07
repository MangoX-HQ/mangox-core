#!/bin/bash

set -e

IMAGE_NAME="thaily/test-1"
TAG="${1:-latest}"

echo "Building image: $IMAGE_NAME:$TAG"
docker build -t "$IMAGE_NAME:$TAG" .

echo "Pushing image: $IMAGE_NAME:$TAG"
docker push "$IMAGE_NAME:$TAG"

echo "Done! Image pushed: $IMAGE_NAME:$TAG"
