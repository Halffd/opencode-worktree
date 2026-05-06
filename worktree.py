#!/usr/bin/env python3
"""opencode-worktree CLI — Manage git worktrees for opencode sessions.

Subcommands:
  create        Create worktree + launch terminal/editor
  delete        Delete worktree (marks for cleanup on session.idle)
  list          List all worktrees for this repo
  prune         Prune stale worktree references
  merge         Merge branch into current worktree
  rebase        Rebase current branch
  cherry-pick   Cherry-pick commits
  squash        Squash N recent commits
  abort         Abort in-progress merge/rebase/cherry-pick
  conflicts     List conflicted files
  ours          Accept ours for conflicted files
  theirs        Accept theirs for conflicted files
  conflict-status Detailed conflict status
  shared-sync   Sync shared files/dirs between main and worktree
  build-dir     Get/set/clean build directory
  shared-list   List configured shared files/dirs
  info          Show worktree info for current directory
  diff          Diff between branches or worktrees
  log           Git log with formatting
  stash         Stash management
  branch        Branch management
  checkout      Checkout branch/commit
  switch        Modern git switch
  tag           Tag management
  remote        Remote management
  fetch         Fetch from remotes
  pull          Pull with rebase option
  push          Push with force/lease options
  reset         Reset operations (with safety guard)
  clean         Clean untracked files (with safety guard)
  commit        Commit with message
  status        Git status
  config        Manage worktree.jsonc config
  cd            Print worktree path (for shell integration)
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

HOME = Path.home()
DEFAULT_WORKTREE_BASE = HOME / ".local" / "share" / "opencode" / "worktree"
DEFAULT_DB_BASE = HOME / ".local" / "share" / "opencode" / "plugins" / "worktree"
CONFIG_DIR = Path(".opencode")


def git(*args: str, cwd: Optional[str] = None) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git"] + [a for a in args if a is not None],
        cwd=cwd or os.getcwd(),
        capture_output=True,
        text=True,
    )
    return result


def git_ok(*args: str, cwd: Optional[str] = None) -> str:
    r = git(*args, cwd=cwd)
    if r.returncode != 0:
        die(f"git {' '.join(args)} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()


def git_try(*args: str, cwd: Optional[str] = None) -> Optional[str]:
    r = git(*args, cwd=cwd)
    return r.stdout.strip() if r.returncode == 0 else None


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def info(msg: str) -> None:
    print(msg)


def get_repo_root(cwd: Optional[str] = None) -> str:
    r = git("rev-parse", "--show-toplevel", cwd=cwd)
    if r.returncode != 0:
        die("not a git repository")
    return r.stdout.strip()


def get_project_id(repo_root: str) -> str:
    cache_file = Path(repo_root) / ".git" / "opencode"
    if cache_file.exists():
        cached = cache_file.read_text().strip()
        if re.match(r'^[a-f0-9]{40}$', cached, re.I) or re.match(r'^[a-f0-9]{16}$', cached, re.I):
            return cached

    r = git("rev-list", "--max-parents=0", "--all", cwd=repo_root)
    if r.returncode == 0:
        roots = sorted(line.strip() for line in r.stdout.splitlines() if line.strip())
        if roots and re.match(r'^[a-f0-9]{40}$', roots[0], re.I):
            try:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(roots[0])
            except OSError:
                pass
            return roots[0]

    import hashlib
    return hashlib.sha256(repo_root.encode()).hexdigest()[:16]


def get_worktree_path(repo_root: str, branch: str, base_path: Optional[str] = None) -> Path:
    project_id = get_project_id(repo_root)
    base = Path(base_path) if base_path else DEFAULT_WORKTREE_BASE
    return base / project_id / branch


def load_config(repo_root: str) -> dict:
    config_path = Path(repo_root) / CONFIG_DIR / "worktree.jsonc"
    if not config_path.exists():
        return {"launchMode": "tmux-window", "sync": {"copyFiles": [], "symlinkDirs": [], "exclude": []}, "hooks": {"postCreate": [], "preDelete": []}}
    try:
        content = config_path.read_text()
        import re as _re
        content = _re.sub(r'//.*?$', '', content, flags=_re.MULTILINE)
        content = _re.sub(r'/\*.*?\*/', '', content, flags=_re.DOTALL)
        trailing = _re.sub(r',\s*([}\]])', r'\1', content)
        return json.loads(trailing)
    except Exception:
        return {}


def save_config(repo_root: str, config: dict) -> None:
    config_path = Path(repo_root) / CONFIG_DIR / "worktree.jsonc"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(config, indent=2) + "\n")


def validate_branch(name: str) -> None:
    if not name:
        die("branch name cannot be empty")
    if name.startswith("-"):
        die("branch name cannot start with '-'")
    if re.search(r'[\x00-\x1f\x7f ~^:?*[\]\\;&|`$()]', name):
        die(f"invalid branch name: {name}")
    if ".." in name:
        die("branch name cannot contain '..'")
    if len(name) > 255:
        die("branch name too long")


def branch_exists(branch: str, cwd: Optional[str] = None) -> bool:
    return git_try("rev-parse", "--verify", branch, cwd=cwd) is not None


def spawn_terminal(cwd: str, argv: Optional[list] = None, mode: str = "tmux-window", name: str = "worktree") -> bool:
    cmd = " ".join(f'"{a}"' for a in argv) if argv else None

    if mode == "tmux-window":
        args = ["tmux", "new-window", "-n", name, "-c", cwd]
        if cmd:
            args += ["--", "bash", "-c", f'cd "{cwd}" && {cmd}; exec $SHELL']
        return subprocess.run(args).returncode == 0

    elif mode == "tmux-session":
        r = subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", cwd] + (["--", "bash", "-c", f'cd "{cwd}" && {cmd}; exec $SHELL'] if cmd else []))
        if r.returncode != 0:
            return False
        subprocess.run(["tmux", "switch-client", "-t", name], capture_output=True)
        return True

    elif mode == "terminal":
        script = f'#!/bin/bash\ncd "{cwd}"\n{cmd}\nexec $SHELL' if cmd else f'#!/bin/bash\ncd "{cwd}"\nexec $SHELL'
        script_path = Path(f"/tmp/worktree-{os.getpid()}.sh")
        script_path.write_text(script)
        script_path.chmod(0o755)

        for term in ["kitty", "alacritty", "ghostty", "gnome-terminal", "konsole", "xterm"]:
            if shutil.which(term):
                if term == "kitty":
                    return subprocess.Popen(["kitty", "--directory", cwd, "-e", "bash", str(script_path)], start_new_session=True).returncode is None
                elif term == "alacritty":
                    return subprocess.Popen(["alacritty", "--working-directory", cwd, "-e", "bash", str(script_path)], start_new_session=True).returncode is None
                elif term == "ghostty":
                    return subprocess.Popen(["ghostty", "-e", "bash", str(script_path)], start_new_session=True).returncode is None
                elif term == "gnome-terminal":
                    return subprocess.Popen(["gnome-terminal", "--working-directory", cwd, "--", "bash", str(script_path)], start_new_session=True).returncode is None
                elif term == "konsole":
                    return subprocess.Popen(["konsole", "--workdir", cwd, "-e", "bash", str(script_path)], start_new_session=True).returncode is None
                elif term == "xterm":
                    return subprocess.Popen(["xterm", "-e", "bash", str(script_path)], start_new_session=True).returncode is None
        die("no terminal emulator found")

    elif mode == "vscode":
        if not shutil.which("code"):
            die("'code' command not found. Install VS Code and add to PATH.")
        return subprocess.Popen(["code", cwd], start_new_session=True).returncode is None

    else:
        die(f"unknown launch mode: {mode}")


def get_conflicts(cwd: str) -> list[str]:
    r = git("diff", "--name-only", "--diff-filter=U", cwd=cwd)
    if r.returncode != 0:
        return []
    return [f for f in r.stdout.strip().splitlines() if f]


# =============================================================================
# COMMANDS — worktree management
# =============================================================================

def cmd_create(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    branch = args.branch
    base_branch = args.base
    launch_mode = args.launch_mode

    validate_branch(branch)
    if base_branch:
        validate_branch(base_branch)

    config = load_config(repo_root)
    if not launch_mode:
        launch_mode = config.get("launchMode", "tmux-window")

    wt_path = get_worktree_path(repo_root, branch, config.get("worktreePath"))
    wt_path.parent.mkdir(parents=True, exist_ok=True)

    if branch_exists(branch, cwd=repo_root):
        git_ok("worktree", "add", str(wt_path), branch, cwd=repo_root)
    else:
        base = base_branch or "HEAD"
        git_ok("worktree", "add", "-b", branch, str(wt_path), base, cwd=repo_root)

    sync = config.get("sync", {})
    for f in sync.get("copyFiles", []):
        src = Path(repo_root) / f
        dst = wt_path / f
        if src.exists() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            info(f"  copied: {f}")

    for d in sync.get("symlinkDirs", []):
        src = Path(repo_root) / d
        dst = wt_path / d
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.symlink_to(src.resolve())
            info(f"  symlinked: {d}")

    hooks = config.get("hooks", {})
    for cmd in hooks.get("postCreate", []):
        subprocess.run(["bash", "-c", cmd], cwd=str(wt_path))
        info(f"  hook: {cmd}")

    argv = ["opencode"]
    ok = spawn_terminal(str(wt_path), argv, mode=launch_mode, name=branch)
    if ok:
        info(f"worktree created at {wt_path} (launched as {launch_mode})")
    else:
        info(f"worktree created at {wt_path} (launch failed)")


def cmd_delete(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    branch = args.branch
    if not branch:
        r = git("branch", "--show-current")
        if r.returncode != 0:
            die("cannot determine current branch")
        branch = r.stdout.strip()

    wt_list = git_ok("worktree", "list", "--porcelain", cwd=repo_root)
    wt_path = None
    for line in wt_list.splitlines():
        if line.startswith("worktree "):
            p = line.split(" ", 1)[1]
            r2 = git("branch", "--show-current", cwd=p)
            if r2.returncode == 0 and r2.stdout.strip() == branch:
                wt_path = p
                break

    if not wt_path:
        die(f"no worktree found for branch: {branch}")

    config = load_config(repo_root)
    for cmd in config.get("hooks", {}).get("preDelete", []):
        subprocess.run(["bash", "-c", cmd], cwd=wt_path)

    git("add", "-A", cwd=wt_path)
    git("commit", "-m", "chore(worktree): session snapshot", "--allow-empty", cwd=wt_path)
    git_ok("worktree", "remove", "--force", wt_path, cwd=repo_root)
    info(f"deleted worktree for branch: {branch}")


def cmd_list(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    wt_list = git_ok("worktree", "list", "--porcelain", cwd=repo_root)
    worktrees: list[dict] = []
    current: dict = {}
    for line in wt_list.splitlines():
        if line.startswith("worktree "):
            current = {"path": line.split(" ", 1)[1]}
            worktrees.append(current)
        elif line.startswith("branch "):
            current["branch"] = line.split(" ", 1)[1].replace("refs/heads/", "")
        elif line.startswith("HEAD "):
            current["head"] = line.split(" ", 1)[1]
        elif line == "bare":
            current["bare"] = True

    for wt in worktrees:
        if wt.get("bare"):
            continue
        branch = wt.get("branch", "(detached)")
        is_main = wt["path"] == repo_root
        marker = " [main]" if is_main else ""
        info(f"  {branch:<30s} {wt['path']}{marker}")


def cmd_prune(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    r = git("worktree", "prune", cwd=repo_root)
    if r.returncode == 0:
        info("pruned stale worktree references")
    else:
        die(f"prune failed: {r.stderr.strip()}")


# =============================================================================
# COMMANDS — merge/rebase/cherry-pick/squash
# =============================================================================

def cmd_merge(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    branch = args.branch
    no_ff = args.no_ff
    msg = args.message

    margs = ["merge", branch]
    if no_ff:
        margs.append("--no-ff")
    if msg:
        margs += ["-m", msg]

    r = git(*margs, cwd=cwd)
    if r.returncode == 0:
        info(f"merged {branch}")
    else:
        if "CONFLICT" in r.stdout or "CONFLICT" in r.stderr:
            conflicts = get_conflicts(cwd)
            info(f"merge conflict in {len(conflicts)} file(s):")
            for f in conflicts:
                info(f"  {f}")
            info("Use 'worktree theirs' or 'worktree ours' to resolve.")
        else:
            die(f"merge failed: {r.stderr.strip() or r.stdout.strip()}")


def cmd_rebase(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    onto = args.onto or "main"
    r = git("rebase", onto, cwd=cwd)
    if r.returncode == 0:
        info(f"rebased onto {onto}")
    else:
        if "CONFLICT" in r.stdout or "CONFLICT" in r.stderr:
            conflicts = get_conflicts(cwd)
            info(f"rebase conflict in {len(conflicts)} file(s):")
            for f in conflicts:
                info(f"  {f}")
        else:
            die(f"rebase failed: {r.stderr.strip() or r.stdout.strip()}")


def cmd_cherry_pick(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    commits = args.commits
    r = git("cherry-pick", *commits, cwd=cwd)
    if r.returncode == 0:
        info(f"cherry-picked {len(commits)} commit(s)")
    else:
        if "CONFLICT" in r.stdout or "CONFLICT" in r.stderr:
            conflicts = get_conflicts(cwd)
            info(f"cherry-pick conflict in {len(conflicts)} file(s):")
            for f in conflicts:
                info(f"  {f}")
        else:
            die(f"cherry-pick failed: {r.stderr.strip() or r.stdout.strip()}")


def cmd_squash(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    count = args.count
    msg = args.message or f"squash: {count} commits"

    git_ok("reset", "--soft", f"HEAD~{count}", cwd=cwd)
    git_ok("commit", "-m", msg, cwd=cwd)
    info(f"squashed {count} commits: {msg}")


def cmd_abort(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    for cmd_name in ["merge", "rebase", "cherry-pick"]:
        r = git(f"{cmd_name}", "--abort", cwd=cwd)
        if r.returncode == 0:
            info(f"aborted {cmd_name}")
            return
    info("no in-progress merge/rebase/cherry-pick to abort")


# =============================================================================
# COMMANDS — conflict resolution
# =============================================================================

def cmd_conflicts(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    conflicts = get_conflicts(cwd)
    if not conflicts:
        info("no conflicts")
    else:
        info(f"{len(conflicts)} conflicted file(s):")
        for f in conflicts:
            info(f"  {f}")


def cmd_ours(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    files = args.files or get_conflicts(cwd)
    if not files:
        info("no conflicts to resolve")
        return
    for f in files:
        git_ok("checkout", "--ours", f, cwd=cwd)
        git_ok("add", f, cwd=cwd)
        info(f"  ours: {f}")
    info(f"resolved {len(files)} file(s) as ours")


def cmd_theirs(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    files = args.files or get_conflicts(cwd)
    if not files:
        info("no conflicts to resolve")
        return
    for f in files:
        git_ok("checkout", "--theirs", f, cwd=cwd)
        git_ok("add", f, cwd=cwd)
        info(f"  theirs: {f}")
    info(f"resolved {len(files)} file(s) as theirs")


def cmd_conflict_status(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    r = git("status", "--porcelain", cwd=cwd)
    if r.returncode != 0:
        die(f"git status failed: {r.stderr.strip()}")

    codes = {"UU": "both modified", "AA": "both added", "DU": "deleted by us", "UD": "deleted by them", "AU": "added by us", "UA": "added by them"}
    found = False
    for line in r.stdout.splitlines():
        idx = line[:2]
        f = line[3:]
        desc = codes.get(idx, "")
        if desc:
            info(f"  {f} — {desc}")
            found = True
    if not found:
        info("no conflicts")


# =============================================================================
# COMMANDS — shared dirs / build dirs
# =============================================================================

def cmd_shared_sync(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    config = load_config(repo_root)
    sync = config.get("sync", {})
    direction = args.direction or "to-worktree"

    if direction == "to-worktree":
        branch = args.branch or git_try("branch", "--show-current", cwd=repo_root) or die("specify --branch or run from a worktree")
        wt_path = get_worktree_path(repo_root, branch, config.get("worktreePath"))
        if not wt_path.exists():
            die(f"worktree not found at {wt_path}")
        source, target = Path(repo_root), wt_path
    else:
        branch = args.branch or die("specify --branch")
        wt_path = get_worktree_path(repo_root, branch, config.get("worktreePath"))
        source, target = wt_path, Path(repo_root)

    count = 0
    for f in sync.get("copyFiles", []):
        src = source / f
        dst = target / f
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            info(f"  copied: {f}")
            count += 1

    for d in sync.get("symlinkDirs", []):
        src = source / d
        dst = target / d
        if src.is_dir():
            if dst.exists() or dst.is_symlink():
                shutil.rmtree(dst, ignore_errors=True)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.symlink_to(src.resolve())
            info(f"  symlinked: {d}")
            count += 1

    info(f"synced {count} item(s) ({direction})")


def cmd_build_dir(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    build_file = Path(cwd) / CONFIG_DIR / "build.json"
    action = args.action

    if action == "get":
        if not build_file.exists():
            info("no build directory configured")
            return
        data = json.loads(build_file.read_text())
        resolved = Path(cwd) / data["dir"]
        info(f"build dir: {data['dir']} (resolved: {resolved}, exists: {resolved.is_dir()})")

    elif action == "set":
        d = args.dir or die("--dir required for set")
        build_file.parent.mkdir(parents=True, exist_ok=True)
        build_file.write_text(json.dumps({"dir": d, "setAt": datetime.now().isoformat()}))
        info(f"build directory set to: {d}")

    elif action == "clean":
        if not build_file.exists():
            die("no build directory configured")
        data = json.loads(build_file.read_text())
        resolved = Path(cwd) / data["dir"]
        if resolved.exists():
            shutil.rmtree(resolved)
        resolved.mkdir(parents=True, exist_ok=True)
        info(f"cleaned build directory: {data['dir']}")

    elif action == "path":
        if build_file.exists():
            data = json.loads(build_file.read_text())
            info(str(Path(cwd) / data["dir"]))
        else:
            info(cwd)
    else:
        die(f"unknown action: {action}. Use: get, set, clean, path")


def cmd_shared_list(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    config = load_config(repo_root)
    sync = config.get("sync", {})

    copy_files = sync.get("copyFiles", [])
    symlink_dirs = sync.get("symlinkDirs", [])
    excludes = sync.get("exclude", [])

    info(f"copy files ({len(copy_files)}):")
    for f in copy_files:
        info(f"  {f}")
    if not copy_files:
        info("  (none)")

    info(f"symlink dirs ({len(symlink_dirs)}):")
    for d in symlink_dirs:
        info(f"  {d} -> {Path(repo_root) / d}")
    if not symlink_dirs:
        info("  (none)")

    if excludes:
        info(f"exclude patterns ({len(excludes)}):")
        for e in excludes:
            info(f"  {e}")

    info(f"\nconfig: {Path(repo_root) / CONFIG_DIR / 'worktree.jsonc'}")


def cmd_info(args: argparse.Namespace) -> None:
    cwd = os.getcwd()
    repo_root = get_repo_root()
    branch = git_try("branch", "--show-current", cwd=cwd) or "(detached)"
    head = git_try("rev-parse", "HEAD", cwd=cwd) or "unknown"

    info(f"path:    {cwd}")
    info(f"root:    {repo_root}")
    info(f"branch:  {branch}")
    info(f"head:    {head[:12]}")

    is_worktree = cwd != repo_root
    info(f"type:    {'worktree' if is_worktree else 'main'}")

    if is_worktree:
        project_id = get_project_id(repo_root)
        wt_path = DEFAULT_WORKTREE_BASE / project_id / branch
        info(f"managed: {wt_path.exists()}")

    conflicts = get_conflicts(cwd)
    info(f"conflicts: {len(conflicts)}")
    for f in conflicts:
        info(f"  {f}")

    config = load_config(repo_root)
    info(f"launch mode: {config.get('launchMode', 'tmux-window')}")
    sync = config.get("sync", {})
    info(f"shared files: {len(sync.get('copyFiles', []))}")
    info(f"shared dirs:  {len(sync.get('symlinkDirs', []))}")


# =============================================================================
# COMMANDS — diff / log / stash
# =============================================================================

def cmd_diff(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    branch = args.branch
    target = args.target or "HEAD"
    stat_only = args.stat

    dargs = ["diff"]
    if stat_only:
        dargs.append("--stat")
    dargs.append(f"{target}...{branch}")

    r = git(*dargs, cwd=cwd)
    if r.returncode != 0:
        dargs2 = ["diff"]
        if stat_only:
            dargs2.append("--stat")
        dargs2.append(branch)
        r2 = git(*dargs2, cwd=cwd)
        if r2.returncode != 0:
            die(f"diff failed: {r.stderr.strip()}")
        info(r2.stdout.strip() if r2.stdout.strip() else "(no diff)")
        return
    info(r.stdout.strip() if r.stdout.strip() else "(no diff)")


def cmd_log(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    n = args.n or 10
    fmt = args.format or "oneline"
    branch = args.branch

    if fmt == "oneline":
        fmt_args = ["--oneline"]
    elif fmt == "medium":
        fmt_args = ["--format=medium"]
    elif fmt == "graph":
        fmt_args = ["--graph", "--oneline", "--decorate"]
    else:
        fmt_args = [f"--format={fmt}"]

    gargs = ["log"] + fmt_args + [f"-{n}"]
    if branch:
        gargs.append(branch)

    r = git(*gargs, cwd=cwd)
    if r.returncode != 0:
        die(f"log failed: {r.stderr.strip()}")
    info(r.stdout.strip())


def cmd_stash(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    action = args.action

    if action == "list":
        r = git("stash", "list", cwd=cwd)
        info(r.stdout.strip() if r.stdout.strip() else "(no stashes)")
    elif action == "push":
        msg = args.message
        gargs = ["stash", "push"]
        if msg:
            gargs += ["-m", msg]
        git_ok(*gargs, cwd=cwd)
        info("stashed")
    elif action == "pop":
        idx = args.index or 0
        git_ok("stash", "pop", f"stash@{{{idx}}}", cwd=cwd)
        info(f"popped stash@{{{idx}}}")
    elif action == "apply":
        idx = args.index or 0
        git_ok("stash", "apply", f"stash@{{{idx}}}", cwd=cwd)
        info(f"applied stash@{{{idx}}}")
    elif action == "drop":
        idx = args.index or 0
        git_ok("stash", "drop", f"stash@{{{idx}}}", cwd=cwd)
        info(f"dropped stash@{{{idx}}}")
    elif action == "show":
        idx = args.index or 0
        r = git("stash", "show", "-p", f"stash@{{{idx}}}", cwd=cwd)
        info(r.stdout.strip() if r.stdout.strip() else "(empty stash)")
    elif action == "branch":
        name = args.branch_name or die("--branch-name required")
        git_ok("stash", "branch", name, cwd=cwd)
        info(f"created branch {name} from stash")
    elif action == "clear":
        git_ok("stash", "clear", cwd=cwd)
        info("cleared all stashes")
    else:
        die(f"unknown stash action: {action}")


# =============================================================================
# COMMANDS — branch / checkout / switch / tag
# =============================================================================

def cmd_branch(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    action = args.action

    if action == "list":
        r = git("branch", "-v", "--list", args.pattern or "", cwd=cwd)
        info(r.stdout.strip() if r.stdout.strip() else "(no branches)")
    elif action == "create":
        name = args.name or die("branch name required")
        validate_branch(name)
        base = args.base or "HEAD"
        git_ok("branch", name, base, cwd=cwd)
        info(f"created branch {name} from {base}")
    elif action == "rename":
        old = args.old_name or die("--old required")
        new = args.new_name or die("--new required")
        git_ok("branch", "-m", old, new, cwd=cwd)
        info(f"renamed {old} -> {new}")
    elif action == "delete":
        name = args.name or die("branch name required")
        force = args.force
        git_ok("branch", "-D" if force else "-d", name, cwd=cwd)
        info(f"deleted branch {name}")
    elif action == "track":
        name = args.name or die("branch name required")
        git_ok("branch", "--set-upstream-to", name, cwd=cwd)
        info(f"tracking {name}")
    else:
        die(f"unknown branch action: {action}")


def cmd_checkout(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    target = args.target
    new_branch = args.new_branch

    if new_branch:
        validate_branch(new_branch)
        git_ok("checkout", "-b", new_branch, target or "HEAD", cwd=cwd)
        info(f"created and switched to {new_branch}")
    else:
        if not target:
            die("target required (or use -b)")
        git_ok("checkout", target, cwd=cwd)
        info(f"switched to {target}")


def cmd_switch(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    branch = args.branch
    create = args.create

    if create:
        validate_branch(branch)
        git_ok("switch", "-c", branch, cwd=cwd)
        info(f"created and switched to {branch}")
    else:
        git_ok("switch", branch, cwd=cwd)
        info(f"switched to {branch}")


def cmd_tag(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    action = args.action

    if action == "list":
        r = git("tag", "-l", args.pattern or "*", cwd=cwd)
        info(r.stdout.strip() if r.stdout.strip() else "(no tags)")
    elif action == "create":
        name = args.name or die("tag name required")
        gargs = ["tag", name]
        if args.annotate:
            msg = args.message or name
            gargs = ["tag", "-a", name, "-m", msg]
        if args.commit:
            gargs.append(args.commit)
        git_ok(*gargs, cwd=cwd)
        info(f"created tag {name}")
    elif action == "delete":
        name = args.name or die("tag name required")
        git_ok("tag", "-d", name, cwd=cwd)
        info(f"deleted tag {name}")
    else:
        die(f"unknown tag action: {action}")


# =============================================================================
# COMMANDS — remote / fetch / pull / push
# =============================================================================

def cmd_remote(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    action = args.action

    if action == "list":
        r = git("remote", "-v", cwd=cwd)
        info(r.stdout.strip() if r.stdout.strip() else "(no remotes)")
    elif action == "add":
        name = args.name or die("remote name required")
        url = args.url or die("remote URL required")
        git_ok("remote", "add", name, url, cwd=cwd)
        info(f"added remote {name} -> {url}")
    elif action == "remove":
        name = args.name or die("remote name required")
        git_ok("remote", "remove", name, cwd=cwd)
        info(f"removed remote {name}")
    elif action == "set-url":
        name = args.name or die("remote name required")
        url = args.url or die("URL required")
        git_ok("remote", "set-url", name, url, cwd=cwd)
        info(f"set {name} URL to {url}")
    else:
        die(f"unknown remote action: {action}")


def cmd_fetch(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    gargs = ["fetch"]
    if args.all:
        gargs.append("--all")
    if args.prune:
        gargs.append("--prune")
    if args.remote and not args.all:
        gargs.append(args.remote)
    git_ok(*gargs, cwd=cwd)
    info("fetched")


def cmd_pull(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    gargs = ["pull"]
    if args.rebase:
        gargs.append("--rebase")
    if args.remote:
        gargs.append(args.remote)
    if args.branch:
        gargs.append(args.branch)
    git_ok(*gargs, cwd=cwd)
    info("pulled")


def cmd_push(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    gargs = ["push"]
    if args.dry_run:
        gargs.append("--dry-run")
    if args.force_with_lease:
        gargs.append("--force-with-lease")
    elif args.force:
        gargs.append("--force")
    if args.remote:
        gargs.append(args.remote)
    if args.branch:
        gargs.append(args.branch)
    r = git(*gargs, cwd=cwd)
    if r.returncode != 0:
        die(f"push failed: {r.stderr.strip()}")
    info(r.stdout.strip() or "pushed")


# =============================================================================
# COMMANDS — reset / clean / commit / status
# =============================================================================

def cmd_reset(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    mode = args.mode
    target = args.target or "HEAD"

    if mode == "hard":
        if not args.i_know_what_im_doing:
            die("hard reset requires --i-know-what-im-doing flag (this is destructive)")
        git_ok("reset", "--hard", target, cwd=cwd)
        info(f"hard reset to {target}")
    elif mode == "soft":
        git_ok("reset", "--soft", target, cwd=cwd)
        info(f"soft reset to {target}")
    elif mode == "mixed":
        git_ok("reset", "--mixed", target, cwd=cwd)
        info(f"mixed reset to {target}")
    else:
        die(f"unknown reset mode: {mode}. Use: soft, mixed, hard")


def cmd_clean(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    gargs = ["clean", "-fd"]

    if args.dry_run:
        gargs.append("--dry-run")
        r = git(*gargs, cwd=cwd)
        info(r.stdout.strip() if r.stdout.strip() else "(nothing to clean)")
        return

    if not args.force:
        die("clean requires --force to actually delete files (use --dry-run first)")

    git_ok(*gargs, cwd=cwd)
    info("cleaned untracked files")


def cmd_commit(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    msg = args.message or die("-m required")
    gargs = ["commit", "-m", msg]
    if args.amend:
        gargs.append("--amend")
    if args.all:
        gargs.insert(1, "-a")
    git_ok(*gargs, cwd=cwd)
    info(f"committed: {msg}")


def cmd_status(args: argparse.Namespace) -> None:
    cwd = get_repo_root()
    gargs = ["status"]
    if args.short:
        gargs.append("--short")
    if args.branch:
        gargs.append("--branch")
    if args.short and args.branch:
        gargs = ["status", "--short", "--branch"]
    r = git(*gargs, cwd=cwd)
    if r.returncode != 0:
        die(f"status failed: {r.stderr.strip()}")
    info(r.stdout.strip())


# =============================================================================
# COMMANDS — config / cd
# =============================================================================

def cmd_config(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    config = load_config(repo_root)
    action = args.action

    if action == "show":
        info(json.dumps(config, indent=2))
    elif action == "get":
        key = args.key
        if not key:
            info(json.dumps(config, indent=2))
            return
        parts = key.split(".")
        val = config
        for part in parts:
            if isinstance(val, dict):
                val = val.get(part)
            else:
                val = None
                break
        if val is None:
            info(f"(not set)")
        elif isinstance(val, (list, dict)):
            info(json.dumps(val, indent=2))
        else:
            info(str(val))
    elif action == "set":
        key = args.key or die("key required")
        value = args.value or die("value required")
        parts = key.split(".")
        obj = config
        for part in parts[:-1]:
            if part not in obj or not isinstance(obj[part], dict):
                obj[part] = {}
            obj = obj[part]
        last = parts[-1]
        try:
            obj[last] = json.loads(value)
        except json.JSONDecodeError:
            obj[last] = value
        save_config(repo_root, config)
        info(f"set {key} = {value}")
    else:
        die(f"unknown config action: {action}. Use: show, get, set")


def cmd_cd(args: argparse.Namespace) -> None:
    repo_root = get_repo_root()
    branch = args.branch

    if not branch:
        r = git("branch", "--show-current", cwd=repo_root)
        if r.returncode == 0:
            branch = r.stdout.strip()
        if not branch:
            info(repo_root)
            return

    wt_list = git_ok("worktree", "list", "--porcelain", cwd=repo_root)
    for line in wt_list.splitlines():
        if line.startswith("worktree "):
            wt_path = line.split(" ", 1)[1]
            r2 = git("branch", "--show-current", cwd=wt_path)
            if r2.returncode == 0 and r2.stdout.strip() == branch:
                info(wt_path)
                return

    config = load_config(repo_root)
    wt_path = get_worktree_path(repo_root, branch, config.get("worktreePath"))
    if wt_path.exists():
        info(str(wt_path))
    else:
        die(f"no worktree found for branch: {branch}")


# =============================================================================
# ARG PARSER
# =============================================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="worktree",
        description="Manage git worktrees for opencode sessions",
    )
    sub = p.add_subparsers(dest="command")

    c = sub.add_parser("create", help="Create worktree + launch terminal/editor")
    c.add_argument("branch", help="Branch name")
    c.add_argument("--base", help="Base branch (default: HEAD)")
    c.add_argument("--launch-mode", choices=["tmux-window", "tmux-session", "terminal", "vscode"], help="Launch mode")

    d = sub.add_parser("delete", help="Delete worktree")
    d.add_argument("branch", nargs="?", help="Branch to delete (default: current)")

    sub.add_parser("list", help="List all worktrees")
    sub.add_parser("prune", help="Prune stale worktree references")

    m = sub.add_parser("merge", help="Merge branch into current worktree")
    m.add_argument("branch", help="Branch to merge")
    m.add_argument("--no-ff", action="store_true", help="No fast-forward")
    m.add_argument("-m", "--message", help="Merge commit message")

    rb = sub.add_parser("rebase", help="Rebase current branch")
    rb.add_argument("onto", nargs="?", default="main", help="Target to rebase onto")

    cp = sub.add_parser("cherry-pick", help="Cherry-pick commits")
    cp.add_argument("commits", nargs="+", help="Commit SHAs to cherry-pick")

    sq = sub.add_parser("squash", help="Squash N recent commits")
    sq.add_argument("count", type=int, help="Number of commits to squash")
    sq.add_argument("-m", "--message", help="Commit message")

    sub.add_parser("abort", help="Abort in-progress merge/rebase/cherry-pick")
    sub.add_parser("conflicts", help="List conflicted files")

    o = sub.add_parser("ours", help="Accept ours for conflicted files")
    o.add_argument("files", nargs="*", help="Files (default: all conflicted)")

    t = sub.add_parser("theirs", help="Accept theirs for conflicted files")
    t.add_argument("files", nargs="*", help="Files (default: all conflicted)")

    sub.add_parser("conflict-status", help="Detailed conflict status")

    ss = sub.add_parser("shared-sync", help="Sync shared files/dirs between main and worktree")
    ss.add_argument("--direction", choices=["to-worktree", "from-worktree"], default="to-worktree")
    ss.add_argument("--branch", help="Target branch (for non-current worktree)")

    bd = sub.add_parser("build-dir", help="Get/set/clean build directory")
    bd.add_argument("action", choices=["get", "set", "clean", "path"], help="Action")
    bd.add_argument("--dir", help="Directory path (for 'set')")

    sub.add_parser("shared-list", help="List configured shared files/dirs")
    sub.add_parser("info", help="Show worktree info for current directory")

    df = sub.add_parser("diff", help="Diff between branches or worktrees")
    df.add_argument("branch", help="Branch to diff against")
    df.add_argument("--target", default="HEAD", help="Target ref (default: HEAD)")
    df.add_argument("--stat", action="store_true", help="Show stat summary only")

    lg = sub.add_parser("log", help="Git log with formatting")
    lg.add_argument("-n", type=int, default=10, help="Number of commits")
    lg.add_argument("--format", choices=["oneline", "medium", "graph"], default="oneline", help="Log format")
    lg.add_argument("branch", nargs="?", help="Branch to show log for")

    st = sub.add_parser("stash", help="Stash management")
    st.add_argument("action", choices=["list", "push", "pop", "apply", "drop", "show", "branch", "clear"], help="Stash action")
    st.add_argument("-m", "--message", help="Stash message (for push)")
    st.add_argument("--index", type=int, default=0, help="Stash index (default: 0)")
    st.add_argument("--branch-name", help="Branch name (for stash branch)")

    br = sub.add_parser("branch", help="Branch management")
    br.add_argument("action", choices=["list", "create", "rename", "delete", "track"], help="Branch action")
    br.add_argument("name", nargs="?", help="Branch name")
    br.add_argument("--pattern", help="Pattern for list")
    br.add_argument("--base", help="Base ref for create")
    br.add_argument("--old", dest="old_name", help="Old name for rename")
    br.add_argument("--new", dest="new_name", help="New name for rename")
    br.add_argument("--force", action="store_true", help="Force delete")

    co = sub.add_parser("checkout", help="Checkout branch/commit")
    co.add_argument("target", nargs="?", help="Target ref to checkout")
    co.add_argument("-b", dest="new_branch", help="Create new branch and checkout")

    sw = sub.add_parser("switch", help="Modern git switch")
    sw.add_argument("branch", help="Branch to switch to")
    sw.add_argument("-c", "--create", action="store_true", help="Create branch and switch")

    tg = sub.add_parser("tag", help="Tag management")
    tg.add_argument("action", choices=["list", "create", "delete"], help="Tag action")
    tg.add_argument("name", nargs="?", help="Tag name")
    tg.add_argument("--pattern", help="Pattern for list")
    tg.add_argument("--annotate", action="store_true", help="Annotated tag")
    tg.add_argument("-m", "--message", help="Tag message")
    tg.add_argument("--commit", help="Commit SHA for tag")

    rm_ = sub.add_parser("remote", help="Remote management")
    rm_.add_argument("action", choices=["list", "add", "remove", "set-url"], help="Remote action")
    rm_.add_argument("name", nargs="?", help="Remote name")
    rm_.add_argument("url", nargs="?", help="Remote URL")

    ft = sub.add_parser("fetch", help="Fetch from remotes")
    ft.add_argument("remote", nargs="?", help="Remote name")
    ft.add_argument("--all", action="store_true", help="Fetch all remotes")
    ft.add_argument("--prune", action="store_true", help="Prune deleted remote branches")

    pl = sub.add_parser("pull", help="Pull with rebase option")
    pl.add_argument("remote", nargs="?", help="Remote name")
    pl.add_argument("branch", nargs="?", help="Branch name")
    pl.add_argument("--rebase", action="store_true", help="Pull with rebase")

    ps = sub.add_parser("push", help="Push with force/lease options")
    ps.add_argument("remote", nargs="?", help="Remote name")
    ps.add_argument("branch", nargs="?", help="Branch name")
    ps.add_argument("--force-with-lease", action="store_true", help="Force push with lease")
    ps.add_argument("--force", action="store_true", help="Force push")
    ps.add_argument("--dry-run", action="store_true", help="Dry run")

    rs = sub.add_parser("reset", help="Reset operations (with safety guard)")
    rs.add_argument("mode", choices=["soft", "mixed", "hard"], help="Reset mode")
    rs.add_argument("target", nargs="?", default="HEAD", help="Target ref")
    rs.add_argument("--i-know-what-im-doing", action="store_true", help="Required for hard reset")

    cl = sub.add_parser("clean", help="Clean untracked files (with safety guard)")
    cl.add_argument("--dry-run", action="store_true", help="Show what would be deleted")
    cl.add_argument("--force", action="store_true", help="Actually delete files")

    cm = sub.add_parser("commit", help="Commit with message")
    cm.add_argument("-m", "--message", help="Commit message")
    cm.add_argument("--amend", action="store_true", help="Amend last commit")
    cm.add_argument("--all", "-a", action="store_true", help="Stage all tracked files")

    sts = sub.add_parser("status", help="Git status")
    sts.add_argument("--short", "-s", action="store_true", help="Short format")
    sts.add_argument("--branch", "-b", action="store_true", help="Show branch info")

    cfg = sub.add_parser("config", help="Manage worktree.jsonc config")
    cfg.add_argument("action", choices=["show", "get", "set"], help="Config action")
    cfg.add_argument("key", nargs="?", help="Config key (dot-notation)")
    cfg.add_argument("value", nargs="?", help="Config value (for set)")

    cd_ = sub.add_parser("cd", help="Print worktree path (for shell integration)")
    cd_.add_argument("branch", nargs="?", help="Branch name (default: current)")

    return p


COMMAND_MAP = {
    "create": cmd_create,
    "delete": cmd_delete,
    "list": cmd_list,
    "prune": cmd_prune,
    "merge": cmd_merge,
    "rebase": cmd_rebase,
    "cherry-pick": cmd_cherry_pick,
    "squash": cmd_squash,
    "abort": cmd_abort,
    "conflicts": cmd_conflicts,
    "ours": cmd_ours,
    "theirs": cmd_theirs,
    "conflict-status": cmd_conflict_status,
    "shared-sync": cmd_shared_sync,
    "build-dir": cmd_build_dir,
    "shared-list": cmd_shared_list,
    "info": cmd_info,
    "diff": cmd_diff,
    "log": cmd_log,
    "stash": cmd_stash,
    "branch": cmd_branch,
    "checkout": cmd_checkout,
    "switch": cmd_switch,
    "tag": cmd_tag,
    "remote": cmd_remote,
    "fetch": cmd_fetch,
    "pull": cmd_pull,
    "push": cmd_push,
    "reset": cmd_reset,
    "clean": cmd_clean,
    "commit": cmd_commit,
    "status": cmd_status,
    "config": cmd_config,
    "cd": cmd_cd,
}


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    handler = COMMAND_MAP.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
