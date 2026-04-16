#!/usr/bin/env bash
set -euo pipefail

# install-local.sh -- Build CLI, compile skills, install compiled outputs to IDE dirs.
# Usage:
#   bash install-local.sh          # full build + install (auto-detect IDEs)
#   bash install-local.sh --skills-only  # skip build, just copy compiled skills
#   bash install-local.sh --compile-only # just compile skills, don't copy
#   bash install-local.sh --uninstall    # remove installed skills

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="cli-runner-learner"
SKILL_NAME="cli-tool-driver"

# ─── Flags ────────────────────────────────────────────────────────────────────

SKILLS_ONLY=false
COMPILE_ONLY=false
UNINSTALL=false

for arg in "$@"; do
  case "$arg" in
    --skills-only)  SKILLS_ONLY=true ;;
    --compile-only) COMPILE_ONLY=true ;;
    --uninstall)    UNINSTALL=true ;;
  esac
done

# ─── IDE directories ─────────────────────────────────────────────────────────

declare -A IDE_DIRS
IDE_DIRS[claude]="$HOME/.claude/skills/$SKILL_NAME"
IDE_DIRS[cursor-rules]="$HOME/.cursor/rules"
IDE_DIRS[cursor-skills]="$HOME/.cursor/skills/$SKILL_NAME"
IDE_DIRS[windsurf-rules]="$HOME/.codeium/windsurf/rules"
IDE_DIRS[windsurf-skills]="$HOME/.codeium/windsurf/skills/$SKILL_NAME"
IDE_DIRS[codex]="$HOME/.codex/skills/$SKILL_NAME"

# ─── Uninstall ────────────────────────────────────────────────────────────────

if $UNINSTALL; then
  echo "==> Uninstalling $SKILL_NAME skills..."
  for key in "${!IDE_DIRS[@]}"; do
    dir="${IDE_DIRS[$key]}"
    if [[ -d "$dir" ]]; then
      # For rules dirs, only remove our specific file
      if [[ "$key" == *-rules ]]; then
        rm -f "$dir/$SKILL_NAME.md" "$dir/$SKILL_NAME.mdc" 2>/dev/null || true
        echo "  removed: $dir/$SKILL_NAME.*"
      else
        rm -rf "$dir"
        echo "  removed: $dir"
      fi
    fi
  done
  echo "==> Done."
  exit 0
fi

# ─── Build ────────────────────────────────────────────────────────────────────

if ! $SKILLS_ONLY; then
  echo "==> Building CLI..."
  cd "$SCRIPT_DIR"
  npm install
  npm run build
  echo "==> Compiling skills..."
  node skill/build/compile.mjs
fi

if $COMPILE_ONLY; then
  echo "==> Compile-only mode, skipping install."
  exit 0
fi

# ─── Install compiled skills ─────────────────────────────────────────────────

echo "==> Installing compiled skills..."

install_file() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "  installed: $dst"
  fi
}

COMPILED="$SCRIPT_DIR/compiled"

# Claude
install_file "$COMPILED/claude/$SKILL_NAME/SKILL.md" "${IDE_DIRS[claude]}/SKILL.md"

# Cursor
install_file "$COMPILED/cursor/rules/$SKILL_NAME.mdc" "${IDE_DIRS[cursor-rules]}/$SKILL_NAME.mdc"
install_file "$COMPILED/cursor/skills/$SKILL_NAME/SKILL.md" "${IDE_DIRS[cursor-skills]}/SKILL.md"

# Windsurf
install_file "$COMPILED/windsurf/rules/$SKILL_NAME.md" "${IDE_DIRS[windsurf-rules]}/$SKILL_NAME.md"
install_file "$COMPILED/windsurf/skills/$SKILL_NAME/SKILL.md" "${IDE_DIRS[windsurf-skills]}/SKILL.md"

# Codex
install_file "$COMPILED/codex/$SKILL_NAME/SKILL.md" "${IDE_DIRS[codex]}/SKILL.md"

echo "==> Done."
