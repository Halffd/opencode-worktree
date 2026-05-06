# opencode-worktree

Manages git worktrees for isolated parallel development, allowing the AI agent to spin up separate working directories on different branches, each launched in its own terminal/tmux window with its own OpenCode session.

## Features

- **Create git worktrees** on new or existing branches
- **Multiple launch modes** - tmux window, tmux session, desktop terminal (kitty/alacritty/ghostty/gnome-terminal/konsole/xterm), or VS Code
- **Session forking** - copies plan.md and delegations into the new worktree
- **Automatic cleanup** - on session idle, pending-deletes trigger `git add -A && git commit && git worktree remove`
- **File sync** between main repo and worktrees (copy files, symlink directories)
- **Merge, rebase, cherry-pick, squash** operations within worktrees
- **Conflict resolution** tools (list conflicts, checkout --theirs/--ours, detailed conflict status)
- **Build directory management** per worktree for monorepo isolation
- **Branch name validation** preventing injection and invalid git ref characters

## Installation

In `opencode.json`:

**From GitHub:**

```json
{
  "plugin": [
    "github:Halffd/opencode-worktree"
  ]
}
```

**From local path:**

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-worktree"
  ]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `worktree_create` | Create a new git worktree on a branch |
| `worktree_delete` | Delete a worktree and clean up |
| `worktree_list` | List all worktrees |
| `worktree_prune` | Prune stale worktrees that no longer exist on disk |
| `worktree_merge` | Merge a worktree branch into current |
| `worktree_rebase` | Rebase a worktree branch |
| `worktree_cherry_pick` | Cherry-pick commits from a worktree |
| `worktree_squash` | Squash commits in a worktree |
| `worktree_abort` | Abort an in-progress merge/rebase/cherry-pick |
| `worktree_conflicts` | List merge conflicts in a worktree |
| `worktree_checkout_theirs` | Checkout --theirs for conflicted files |
| `worktree_checkout_ours` | Checkout --ours for conflicted files |
| `worktree_conflict_status` | Detailed conflict status |
| `worktree_shared_sync` | Sync shared files between main and worktree |
| `worktree_build_dir` | Manage build directories per worktree |
| `worktree_shared_list` | List shared file configurations |

## Configuration

Create `.opencode/worktree.jsonc` in your project:

| Option | Default | Description |
|--------|---------|-------------|
| `worktreePath` | `~/.local/share/opencode/worktree` | Custom base path for worktree storage (supports `~`) |
| `launchMode` | `"tmux-window"` | Default launch mode: tmux-window, tmux-session, terminal, vscode |
| `sync.copyFiles` | `[]` | Files to copy from main to new worktrees |
| `sync.symlinkDirs` | `[]` | Directories to symlink (saves disk space) |
| `sync.exclude` | `[]` | Patterns to exclude from copying |
| `hooks.postCreate` | `[]` | Shell commands to run after worktree creation |
| `hooks.preDelete` | `[]` | Shell commands to run before worktree deletion |
