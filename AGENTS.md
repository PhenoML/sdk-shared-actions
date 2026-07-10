# Repository guidance

Shared GitHub Actions and reusable workflows for the Phenoml SDK repos. See
[README.md](README.md) for what each action and workflow does.

## Conventional commits & releases

Releases are automated by **release-please** (`.github/workflows/release-please.yml`).
It maintains a rolling release PR off `main` and decides the next version
**entirely from commit-message prefixes**, so every commit must follow
[Conventional Commits](https://www.conventionalcommits.org). A release also
rewrites the sibling-action pins inside reusable workflows in lockstep, and
tags are unprefixed (`1.0.0`, not `v1.0.0`).

PR titles should also use Conventional Commit format, because squash merges use
the PR title as the final commit message by default.

### Which prefixes cut a release

A commit triggers a release **only** if its prefix is:

| Prefix | Bump |
| --- | --- |
| `feat` | minor |
| `fix` | patch |
| `deps` | patch |
| any of the above with `!`, or a `BREAKING CHANGE:` footer | major |

Everything else — `ci`, `chore`, `docs`, `build`, `refactor`, `test`, `style`,
`perf` — does **not** trigger a release.

### Rule of thumb: does the change affect consumers?

Use a releasing prefix (`feat`/`fix`/`deps`) **only** when the change touches the
consumer-facing surface — the composite actions (`bundle-openapi-spec`,
`extract-code-examples`, `commit-artifacts`, `verify-openapi-spec`) or the
reusable workflows that SDK repos call.

For changes with **no effect on external consumers**, use a non-releasing prefix
so release-please doesn't cut a pointless release:

- `.github/workflows/release-please.yml` (the release machinery itself, which
  nobody consumes) → `ci:` or `chore:`
- repo meta — README, this file, `.gitignore`, internal-only CI → `docs:` /
  `chore:` / `ci:`

release-please can't tell a change is internal-only; the prefix is the only
signal. Labeling an internal workflow tweak `fix:` *will* cut a release, and
there is no config knob to exempt a type or scope from releasing.

### Scope

Use the action or workflow name as the scope, e.g.
`fix(extract-code-examples): …`, `ci(release-please): …`,
`feat(sync-fern-artifacts): …`, `feat(sdk-release-gate): …`,
`feat(sdk-release-finalize): …`.
