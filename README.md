# cli-runner-learner (clr)

cli-runner-learner publishes an installable, prebuilt CLI runtime and generated CLI-driver skill artifacts.

This main branch is the stable static release branch. Source development happens on dev.

## Install

Run npm install, then run bash install-local.sh.

The static release includes the prebuilt clr runtime in dist/ and generated skills in compiled/. Full setup installs runtime dependencies, links clr globally, and copies compiled skills to detected IDE directories.

## CLI

Run node dist/cli.js --help.

After setup, run clr --help.

## Installer Flags

- --skills-only copies skills from compiled/ without linking the CLI.
- --compile-only is for the source dev branch and fails on static main.
- --uninstall removes installed skill artifacts.

## Branches

- main: static release branch with dist/, compiled/, profiles, installer, public docs, and site files.
- dev: canonical source branch with src/, skill/, TypeScript config, compiler, and development tooling.

To modify CLI source, skill source, fragments, compiler behavior, or release automation, branch from dev.

## Included Release Artifacts

- dist/
- compiled/claude/
- compiled/cursor/
- compiled/windsurf/
- compiled/opencode/
- compiled/codex/
- profiles/
- adapter-overrides.json
- install-local.sh
- site/

## Requirements

- Node.js >= 20
- Native build toolchain for node-pty runtime dependency when npm installs dependencies

## Website

The static website is deployed from the tracked site/ directory on main.
