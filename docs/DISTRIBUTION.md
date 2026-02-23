# Distribution

## Targets

- `npx claude-on-discord ...` from npm (primary)
- Homebrew tap formula generated from published npm tarball

## Maintainer Release Flow

1. Bump `version` in `package.json`.
2. Run checks:

```bash
bun run test
bun run typecheck
bun run dist:check
```

3. Publish npm package:

```bash
npm publish --access public
```

4. Verify npx:

```bash
npx claude-on-discord@latest --help
```

5. Generate Homebrew formula from the published tarball:

```bash
bun run dist:brew:formula -- --version <x.y.z>
```

Default output path:

- `dist/homebrew/claude-on-discord.rb`

Commit that formula into your tap repo (for example `homebrew-tap/Formula/claude-on-discord.rb`) and push.

## User Install Paths

`npx` (recommended):

```bash
npx claude-on-discord setup
npx claude-on-discord start
```

Git clone:

```bash
git clone https://github.com/spanishflu-est1918/claude-on-discord
cd claude-on-discord
bun install
bun run setup
bun start
```
