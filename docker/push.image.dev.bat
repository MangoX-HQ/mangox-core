@echo off
REM filepath: e:\MangoAds\mangox-backend-api\push.image.dev.bat

REM script build image and push to docker hub
REM build image
echo Building Docker image...
docker build --platform linux/amd64 -t registry.gitlab.com/mangoads/mangoxs-backend-api:arm64 -f Dockerfile.dev .

if %errorlevel% neq 0 (
    echo Error: Docker build failed!
    exit /b 1
)

REM tag image
echo Tagging Docker image...
docker tag registry.gitlab.com/mangoads/mangoxs-backend-api:arm64 registry.gitlab.com/mangoads/mangoxs-backend-api:arm64

if %errorlevel% neq 0 (
    echo Error: Docker tag failed!
    exit /b 1
)

REM docker push
echo Pushing Docker image to registry...
docker push registry.gitlab.com/mangoads/mangoxs-backend-api:arm64

if %errorlevel% neq 0 (
    echo Error: Docker push failed!
    exit /b 1
)

REM Xoa cac Docker images khong duoc su dung boi bat ky container nao
echo Cleaning up unused Docker images...
docker image prune -a -f

if %errorlevel% neq 0 (
    echo Warning: Docker image prune had issues, but continuing...
)

echo.
echo ============================================
echo    BUILD AND PUSH COMPLETED SUCCESSFULLY!
echo ============================================
echo.

pause