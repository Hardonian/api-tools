# Contributing

Thanks for contributing to Hardonia. This guide applies to all Hardonia monorepos.

## Toolchain

| Ecosystem | Package manager | Runtime |
|-----------|----------------|---------|
| TypeScript / Node.js | **pnpm** (workspaces) | Node 20+ |
| Python | **uv** | Python 3.11+ |

Do not use npm or pip directly. All workspaces are managed through the repo root.

## Branch Naming

| Prefix | Use |
|--------|-----|
| `feature/*` | New functionality |
| `fix/*` | Bug fixes |
| `chore/*` | Tooling, CI, docs, dependency updates |

Examples: `feature/warranty-url-parser`, `fix/review-confidence-score`, `chore/upgrade-vitest`

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat(warranty-weasel): add multi-page warranty scraping
fix(review-radar): correct confidence calculation for low-sample reviews
chore(ci): update GitHub Actions to Node 20
docs(readme): add Related Repos section
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`

## Pull Requests

1. Branch from `main`
2. Keep PRs focused — one feature or fix per PR
3. Include tests for new functionality
4. Update documentation if behavior changes
5. Ensure CI passes before requesting review

## Development

### TypeScript repos (consumer-tools, api-tools)

```bash
pnpm install          # Install all workspace dependencies
pnpm -r lint          # Lint all packages
pnpm -r test          # Test all packages
pnpm -r build         # Build all packages
```

### Python repos (ops-tools/continuity, ops-tools/drift-inspector)

```bash
cd <component>
uv venv               # Create virtual environment
uv pip install -e .   # Install in editable mode
make test             # Run tests (or: uv run pytest)
```

## Code Style

- **TypeScript:** ESLint + Prettier (configs in each package)
- **Python:** Ruff for linting and formatting
- No trailing whitespace, LF line endings

## License

Each module retains its own license. By contributing, you agree your code will be licensed under the module's existing license.
