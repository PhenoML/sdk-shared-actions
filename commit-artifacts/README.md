# commit-artifacts

Composite action. Stages the given paths, commits them with the provided
message, and pushes to the current branch. The push retries on non-fast-forward
by rebasing onto the new remote tip, so it co-exists with anything else
(another workflow, a human) pushing to the same branch concurrently. No-ops
when the staged paths carry no changes.

This is the single "write it back to the branch" step shared by the
generator actions ([`bundle-openapi-spec`](../bundle-openapi-spec) and
[`extract-code-examples`](../extract-code-examples)), which only produce files
in the working tree and leave committing to this action. Bundling both
generated artifacts into one commit step means a spec update and its derived
code examples land in a **single commit**, so a consumer can never observe one
without the other.

## Usage

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ github.event.pull_request.head.ref }}
# ... steps that generate/modify the artifacts ...
- uses: PhenoML/sdk-shared-actions/commit-artifacts@1.0.0
  with:
    paths: |
      openapi/openapi.json
      code-examples.json
    message: "chore: sync generated artifacts"
```

Requires `permissions: contents: write` and a checkout of the target branch
with push auth. See [`action.yml`](action.yml) for inputs (`paths`, `message`).
