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
SOURCE_BUILD_AVAILABLE=false

if [[ -d "$SCRIPT_DIR/src" && -f "$SCRIPT_DIR/skill/build/compile.mjs" ]]; then
  SOURCE_BUILD_AVAILABLE=true
fi

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

CLAUDE_DIR="$HOME/.claude/skills/$SKILL_NAME"
CURSOR_RULES_DIR="$HOME/.cursor/rules"
CURSOR_SKILLS_DIR="$HOME/.cursor/skills/$SKILL_NAME"
WINDSURF_RULES_DIR="$HOME/.codeium/windsurf/rules"
WINDSURF_SKILLS_DIR="$HOME/.codeium/windsurf/skills/$SKILL_NAME"
CODEX_DIR="$HOME/.codex/skills/$SKILL_NAME"

# ─── Uninstall ────────────────────────────────────────────────────────────────

if $UNINSTALL; then
  echo "==> Uninstalling $SKILL_NAME skills..."
  rm -rf "$CLAUDE_DIR" "$CURSOR_SKILLS_DIR" "$WINDSURF_SKILLS_DIR" "$CODEX_DIR"
  rm -f "$CURSOR_RULES_DIR/$SKILL_NAME.mdc" "$WINDSURF_RULES_DIR/$SKILL_NAME.md" 2>/dev/null || true
  echo "  removed: $CLAUDE_DIR"
  echo "  removed: $CURSOR_SKILLS_DIR"
  echo "  removed: $WINDSURF_SKILLS_DIR"
  echo "  removed: $CODEX_DIR"
  echo "  removed: $CURSOR_RULES_DIR/$SKILL_NAME.mdc"
  echo "  removed: $WINDSURF_RULES_DIR/$SKILL_NAME.md"
  echo "==> Done."
  exit 0
fi

# ─── Build ────────────────────────────────────────────────────────────────────

if $COMPILE_ONLY; then
  if ! $SOURCE_BUILD_AVAILABLE; then
    echo "ERROR: --compile-only requires the source branch (dev). Static main installs release artifacts only."
    exit 1
  fi
  echo "==> Compiling skills..."
  cd "$SCRIPT_DIR"
  node skill/build/compile.mjs
  echo "==> Compile-only mode, skipping install."
  exit 0
fi

if ! $SKILLS_ONLY; then
  cd "$SCRIPT_DIR"
  if $SOURCE_BUILD_AVAILABLE; then
    echo "==> Building CLI..."
    npm install
    npm run build
    echo "==> Compiling skills..."
    node skill/build/compile.mjs
  else
    if [[ ! -f "$SCRIPT_DIR/dist/cli.js" || ! -d "$SCRIPT_DIR/compiled" ]]; then
      echo "ERROR: Static release is missing dist/ or compiled/. Use the dev branch to rebuild release artifacts."
      exit 1
    fi
    echo "==> Installing runtime dependencies from static release..."
    npm install --omit=dev
    chmod +x "$SCRIPT_DIR/dist/cli.js"
    echo "==> Linking clr globally..."
    npm link
  fi
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
install_file "$COMPILED/claude/$SKILL_NAME/SKILL.md" "$CLAUDE_DIR/SKILL.md"

# Cursor
install_file "$COMPILED/cursor/rules/$SKILL_NAME.mdc" "$CURSOR_RULES_DIR/$SKILL_NAME.mdc"
install_file "$COMPILED/cursor/skills/$SKILL_NAME/SKILL.md" "$CURSOR_SKILLS_DIR/SKILL.md"

# Windsurf
install_file "$COMPILED/windsurf/rules/$SKILL_NAME.md" "$WINDSURF_RULES_DIR/$SKILL_NAME.md"
install_file "$COMPILED/windsurf/skills/$SKILL_NAME/SKILL.md" "$WINDSURF_SKILLS_DIR/SKILL.md"

# Codex
install_file "$COMPILED/codex/$SKILL_NAME/SKILL.md" "$CODEX_DIR/SKILL.md"

echo "==> Done."
