#!/usr/bin/env bash
set -euo pipefail

# Navigate to project root (two levels up from scripts directory)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../" && pwd)"
cd "$PROJECT_ROOT"

# Resolve token from environment or .env file
TOKEN="${GITHUB_TOKEN:-}"
if [[ -z "$TOKEN" && -f ".env" ]]; then
  TOKEN="$(grep -E '^GITHUB_TOKEN=' .env | cut -d '=' -f2- | tr -d ' "\r\n' || true)"
fi

REPO_OWNER="the-pacemaker"
REPO_NAME="snuggle2"

if [[ -n "$TOKEN" ]]; then
  REMOTE_URL="https://${REPO_OWNER}:${TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
  git remote set-url origin "$REMOTE_URL"
fi

# Check if there are changes to commit
if [[ -n "$(git status --porcelain)" ]]; then
  COMMIT_MSG="${1:-Update project files}"
  echo "Staging changes..."
  git add -A
  echo "Committing changes with message: '$COMMIT_MSG'..."
  git commit -m "$COMMIT_MSG"
else
  echo "Working tree is clean. Checking for unpushed commits..."
fi

# Push to origin master
echo "Pushing to GitHub (${REPO_OWNER}/${REPO_NAME}:master)..."
GIT_TERMINAL_PROMPT=0 git push origin master

echo "Push successful! Head commit: $(git rev-parse --short HEAD)"
