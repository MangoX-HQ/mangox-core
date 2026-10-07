# #!/bin/bash
set -e
docker login registry.gitlab.com

docker build --platform linux/arm64 -t registry.gitlab.com/mangoads/mangoxs-backend-api:arm64 -f Dockerfile.dev .
docker push registry.gitlab.com/mangoads/mangoxs-backend-api:arm64

docker build --platform linux/amd64 -t registry.gitlab.com/mangoads/mangoxs-backend-api:amd64 -f Dockerfile.dev .
docker push registry.gitlab.com/mangoads/mangoxs-backend-api:amd64

