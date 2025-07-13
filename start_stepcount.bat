@echo off
cd /d D:\tesseract\stepcount\test_step

REM Optional: install dependencies (do only once if needed)
rem call pnpm install

REM Start TypeScript server
start "" cmd /k "cd /d D:\tesseract\stepcount\test_step && pnpm run start"

REM Start Cloudflare tunnel
start "" cmd /k "cloudflared tunnel --url http://localhost:4000"
