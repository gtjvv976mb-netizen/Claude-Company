#!/usr/bin/env bash
# Generate ClaudeCompany.xcodeproj from project.yml and open it in Xcode.
# Needs a Mac with Xcode 15+; installs XcodeGen through Homebrew if it is missing.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v xcodegen >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || { echo "Homebrew is needed to install xcodegen: https://brew.sh" >&2; exit 1; }
  brew install xcodegen
fi
xcodegen generate
echo "Generated ClaudeCompany.xcodeproj — pick your team under Signing & Capabilities, then Run."
open ClaudeCompany.xcodeproj
