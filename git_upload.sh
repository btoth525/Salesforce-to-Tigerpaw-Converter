#!/bin/zsh
# Usage: ./git_upload.sh <your-github-username> <your-repo-name>
# This script will initialize git, add all files, commit, and push to GitHub.

set -e

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <github-username> <repo-name>"
  exit 1
fi

GITHUB_USER=$1
REPO_NAME=$2
REPO_URL="https://github.com/$GITHUB_USER/$REPO_NAME.git"

cd "$(dirname "$0")"

git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin "$REPO_URL"
git push -u origin main

echo "Project uploaded to $REPO_URL"
