---
name: push-to-github
description: Stages, commits, and pushes project code to GitHub (the-pacemaker/snuggle2) using the project's authorized credentials. Use whenever the user explicitly asks to "push to github", "push the code to github", "push to remote", or "sync to github".
---

# Push to GitHub (snuggle2)

This skill automates committing and pushing updates to the GitHub remote repository (`the-pacemaker/snuggle2`) safely using the workspace's authorized credentials.

## Prerequisites & Policy
- **Workspace Permission Rule:** In accordance with the workspace safety policy in `AGENTS.md`, never push to GitHub or interact with remote repositories unless the user has given an **explicit, direct instruction** to push code.
- **Credential Storage:**
  - The authorized personal access token for `the-pacemaker` is kept in local `.env` (`GITHUB_TOKEN=...`, which is git-ignored) and in `.git/config`.
  - **Do NOT commit the raw token into any tracked repository files**, as GitHub Push Protection automatically rejects pushes containing exposed personal access tokens.

## Usage Options

### Option A: Using the Automated Push Helper Script (Recommended)
Run the project skill helper script:
```bash
./.agents/skills/push-to-github/scripts/push.sh "<descriptive commit message>"
```
This script:
1. Automatically reads the token from `.env` or the current environment.
2. Ensures the `origin` remote URL is configured for `the-pacemaker`.
3. Checks for any uncommitted changes, stages them with `git add -A`, and commits them.
4. Executes non-interactive push (`GIT_TERMINAL_PROMPT=0 git push origin master`).
5. Prints the resulting commit hash and status.

### Option B: Manual Git Commands
If preferred or if custom staging is required:

1. **Check status:**
   ```bash
   git status
   ```
   Ensure temporary scratch or debug files are cleaned or git-ignored.

2. **Stage and commit:**
   ```bash
   git add <files>
   git commit -m "<concise description of changes>"
   ```

3. **Verify remote URL:**
   Confirm `origin` points to `the-pacemaker/snuggle2.git` with the token configured in the remote URL or credential store.

4. **Push:**
   ```bash
   GIT_TERMINAL_PROMPT=0 git push origin master
   ```
   *(In agent tool execution, use `WaitMsBeforeAsync: 10000` to allow the network push to complete synchronously without timing out.)*

5. **Report to user:**
   Verify `git status` shows `Your branch is up to date with 'origin/master'` and provide a short summary of the commit.
