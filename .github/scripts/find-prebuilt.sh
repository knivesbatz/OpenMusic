#!/usr/bin/env bash
# Prints the id of a successful pull_request run of workflow $1 (from this repository, not a fork)
# that built exactly this commit's files (its head commit has the same git tree as HEAD) and still
# has every artifact named in $2...; prints nothing when there is none. A squash merge of an
# up-to-date pull request has its head's tree, so a release can publish what that run built and
# tested instead of building it again.
set -euo pipefail
wf=$1
shift
tree=$(git rev-parse 'HEAD^{tree}')
gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$wf/runs?event=pull_request&status=success&per_page=40" \
  --jq ".workflow_runs[] | select(.head_repository.full_name == \"$GITHUB_REPOSITORY\") | \"\(.id) \(.head_sha)\"" |
  while read -r id sha; do
    t=$(gh api "repos/$GITHUB_REPOSITORY/git/commits/$sha" --jq .tree.sha 2>/dev/null) || continue
    [ "$t" = "$tree" ] || continue
    have=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/artifacts" --jq '.artifacts[] | select(.expired | not) | .name')
    ok=1
    for a in "$@"; do grep -qxF "$a" <<<"$have" || ok=0; done
    if [ "$ok" = 1 ]; then
      echo "$id"
      exit 0
    fi
  done
