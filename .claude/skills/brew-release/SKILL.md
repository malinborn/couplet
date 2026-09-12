---
name: brew-release
description: Build, release, and publish a new mdmini version to Homebrew — version bump, changelog/site update, git tag, local universal .dmg build, GitHub release, and Homebrew cask update. Use when the user wants to release, ship, cut a version, or publish md-mini to Homebrew.
---

# Brew Release

End-to-end release of mdmini. There is **no CI** — the `.dmg` is built locally and everything is published by hand. Builds are **universal** (Apple Silicon + Intel) as of 1.0.1.

## Facts

| Thing | Value |
|-------|-------|
| App repo | `malinborn/mdmini` (default branch `main`) |
| Homebrew tap repo | `malinborn/homebrew-mdmini` (cask at `Casks/mdmini.rb`, branch `main`) |
| Cask / CLI name | `mdmini` (app bundle is `md-mini.app`; dmg filename uses `md-mini`) |
| dmg artifact | `md-mini_<version>_universal.dmg` |
| Bundle output dir | `$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle/` — **note `CARGO_TARGET_DIR` is set to `~/.cargo/shared-target`, so this is NOT under `src-tauri/target/`**. Resolve it with `cargo metadata --format-version 1 --no-deps --manifest-path src-tauri/Cargo.toml --jq '.target_directory'` rather than hardcoding. |
| Version lives in | `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json` (NOT `Cargo.toml` — stays `0.1.0`) |
| Changelog / site | **source** `site/index.html`, **built** into `docs/` by `npm run build:site` |
| Tag format | `v<version>` |

## Steps

### 1. Decide the version
SemVer over current `package.json` version. `fix:` -> patch, new user-facing feature -> minor. **Confirm the number with the user** — it is a published, hard-to-reverse artifact. If your reading of semver differs from theirs, say so once, then follow their call.

### 2. Land the changes on main
If releasing a PR whose branch is a clean fast-forward over `main`, preserve its commits:
```bash
git merge-base --is-ancestor origin/main <branch> && echo ff-clean
git push origin <branch>:main      # GitHub auto-marks the PR as MERGED
```
Otherwise `gh pr merge`, or just commit straight to `main` for a solo release.

**If you are an agent forbidden from pushing to main**, prepare the commits on a branch and hand the user a single copy-pasteable command instead of stopping.

### 3. Bump version (3 files)
```bash
npm version <version> --no-git-tag-version    # updates package.json + package-lock.json
```
Then edit `src-tauri/tauri.conf.json` -> `"version": "<version>"`. All three must match.

### 4. Update the site — edit `site/index.html`, then build into `docs/`

**`docs/` is build output. Never edit `docs/index.html` directly.** `vite.config.site.ts` has `root: site/` and `outDir: docs/`, so the next `npm run build:site` silently overwrites anything hand-written there. Read `site/CLAUDE.md` before touching this step.

Edit **`site/index.html`**:
- `"softwareVersion": "<version>"` (JSON-LD near the top).
- Add a `.changelog-entry` block at the **TOP** of `.changelog-list` (use the template already in the file) and move the `open` attribute onto it, off the previous newest entry. Tag is `feature` / `fix` / `perf` / `initial`. Mirror the playful title + `<strong>lead-in</strong> — description` bullets, and use `&mdash;`, not a literal em dash. Match the existing entries' voice: name the actual cause ("the culprit was a single arch-dependent type…"), no marketing adjectives.
- **Only if the release adds a headline feature**, also touch the hero/feature blocks higher in the page. A pure bugfix -> changelog entry only.

Then build:
```bash
rm -rf docs/assets && npm run build:site
```
`rm -rf docs/assets` first because `emptyOutDir: false` — Vite never cleans `docs/`, since it also holds hand-maintained files the build must not eat (`screenshot.png`, `robots.txt`, `sitemap.xml`, `llms.txt`, the favicons, `sample.md`, `releases/`, the internal `*.md` docs). Without the `rm`, content-hashed chunks from every previous release pile up forever, orphans included.

Optionally write the English release notes to `docs/releases/<version>.md` — that file is hand-maintained, not generated, and doubles as the GitHub release body in step 7.

### 5. Commit (two commits, matching repo history)
```bash
git add package.json package-lock.json src-tauri/tauri.conf.json
git commit -m "chore: release <version> — <summary>"
git add site/index.html docs/index.html docs/assets
git commit -m "docs: update site for <version> — <summary>"
git push origin HEAD:main      # or <branch>:main from a worktree
```

### 6. Tag
```bash
git tag v<version> <commit>
git push origin v<version>
```

**Or skip this step entirely** — `gh release create --target <branch>` in step 9 creates the tag for you, on that branch's head. That is what unblocks a release when you cannot push to `main` yourself: publish first, land `main` after. A later fast-forward of the branch into `main` preserves the SHAs, so the tag stays valid and still points into `main`'s history.

### 7. Build the universal dmg locally
```bash
pkill -9 -f "debug/md-mini" 2>/dev/null   # stop any dev:app instance
npm run build:universal                    # tauri build --target universal-apple-darwin
```
Needs both rustup targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

Output: `<target-dir>/universal-apple-darwin/release/bundle/dmg/md-mini_<version>_universal.dmg`.
`tauri build` does **not** install or run the app, so it does not disrupt a running production mdmini (unlike `tauri dev`).

Sanity-check both the bundled CLI and the architectures actually present:
```bash
ls "$BUNDLE/macos/md-mini.app/Contents/Resources/bin/mdmini"
lipo -archs "$BUNDLE/macos/md-mini.app/Contents/MacOS/md-mini"   # expect: x86_64 arm64
```
`lipo -archs` is the one check that catches a silently arm64-only "universal" build.

### 8. sha256
```bash
shasum -a 256 "$BUNDLE/dmg/md-mini_<version>_universal.dmg"
```

### 9. GitHub release
```bash
gh release create v<version> \
  "$BUNDLE/dmg/md-mini_<version>_universal.dmg" \
  --repo malinborn/mdmini \
  --title "v<version> — <summary>" \
  --notes-file <notes.md>
```
Add `--target <branch>` when the tag does not exist yet (see step 6).

### 9a. Re-check the sha256 against what GitHub actually serves

Do this **before** touching the cask, not after. It costs one download and it is
the only thing standing between a mismatched hash and a broken
`brew install` for every user:

```bash
curl -sL -o /tmp/verify.dmg \
  "https://github.com/malinborn/mdmini/releases/download/v<version>/md-mini_<version>_universal.dmg"
shasum -a 256 /tmp/verify.dmg   # must equal the sha256 from step 8
```

### 10. Update the Homebrew cask
In `malinborn/homebrew-mdmini`, edit `Casks/mdmini.rb` — change **only** `version "<version>"` and `sha256 "<new-sha>"` (the `url` uses interpolation, no edit needed).

The migration to universal was done in 1.0.1 — the cask no longer has `depends_on arch: :arm64` and its url already says `_universal.dmg`. **Never reintroduce either**: `depends_on arch:` locks Intel users out no matter what you publish, and an `_aarch64` url 404s against a universal release.

```bash
BLOB_SHA=$(gh api repos/malinborn/homebrew-mdmini/contents/Casks/mdmini.rb --jq '.sha')
# edit version + sha256, base64 the file, then:
gh api -X PUT repos/malinborn/homebrew-mdmini/contents/Casks/mdmini.rb \
  -f message="chore: bump mdmini to <version>" \
  -f content="<base64 of new cask>" -f sha="$BLOB_SHA"
```

### 11. Verify
```bash
gh release view v<version> --json assets --jq '[.assets[].name]'
gh api repos/malinborn/homebrew-mdmini/contents/Casks/mdmini.rb --jq '.content' | base64 -d | grep -E 'version|sha256|depends_on|url'
```
User upgrades with `brew update && brew upgrade --cask mdmini` — **suggest it, don't run it yourself**; it replaces their installed app.

## Notes / Gotchas

- **Universal since 1.0.1.** One dmg, both arches, one sha256 in the cask — no `Hardware::CPU.arm?` branch. Size, measured on 1.0.1: arm64-only was 7 MB, universal is 15 MB. `lipo` merges only the executable, but here the executable is nearly all the weight, so expect slightly over 2x — not the "well under 2x" you might reason your way to.
- **The cask goes last.** It is the switch that actually moves users onto the new version; everything before it is staging. Publish the release, verify the served sha256, *then* bump the cask.
- **Pushing `main` also deploys the site.** `deploy-site.yml` runs on push to `main` touching `docs/**`, so the changelog entry from step 4 only goes live then — a release published from a branch leaves md-mini.com showing the previous version until `main` lands. Note the path filter: a changelog edited in `site/` but never built into `docs/` does not deploy at all.
- **`docs/` is generated; `site/` is the source.** This bit the runbook itself — step 4 used to say the changelog "lives in `docs/index.html`", which is true of the served file and false of the one to edit. `vite.config.site.ts`: `root: site/`, `outDir: docs/`, `emptyOutDir: false`. A hand-edit to `docs/index.html` survives right up until the next `npm run build:site` erases it, which is the kind of trap that reads authoritative and costs an hour.
- **Never pass a `bool` literal to an Objective-C API.** `objc`'s `BOOL` is `bool` on aarch64 but `i8` elsewhere, so `foo_(true)` compiles on Apple Silicon and breaks the x86_64 half of the universal build. Use `cocoa::base::YES`/`NO`. `npm run check:x86` catches this in seconds; it is the reason Intel was broken through 1.0.
- **`CARGO_TARGET_DIR` is redirected** to `~/.cargo/shared-target`, so bundle paths are *not* under `src-tauri/target/`. Resolve the dir, don't hardcode it.
- **dmg filename uses `md-mini`** (`md-mini_X.Y.Z_universal.dmg`), but the cask/CLI name is `mdmini`.
- **Committed broken symlinks.** `src-tauri/target` (and sometimes `node_modules`) have historically been tracked as self-referential absolute symlinks despite `.gitignore`. Stage release files **explicitly** (never `git add -A`) so a typechange can't leak into the release commit.
- **No `latest.json` / updater** wired up (see `docs/distribution.md` section 2) — just the dmg + cask, no signature step. The in-app update notice polls the GitHub releases API instead.
- The cask has a `postflight` that strips the quarantine xattr (unsigned app).

See `docs/distribution.md` for the distribution design.
