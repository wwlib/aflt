#!/usr/bin/env bash
# End-to-end smoke: install hello-aflt seed, validate (no outside-cwd warnings),
# run the full loop with cursor in the foreground. Do not run in CI by default.
set -euo pipefail

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
AFLT_BIN="${AFLT_BIN:-$REPO_ROOT/bin/af.js}"
if [[ ! -f "$AFLT_BIN" ]]; then
  echo "hello-aflt-smoke: missing AFLT_BIN=$AFLT_BIN" >&2
  exit 1
fi

SPACE_NAME="hello-aflt-smoke-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hello-aflt-smoke.XXXXXX")"
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

unset AGENTFLEET_HOME
export AFLT_SPACE="$SPACE_NAME"
export AGENTFLEET_ENGINE=cursor

(
  cd "$WORK"
  bash "$REPO_ROOT/examples/loops/hello-aflt/install.sh"
  git init -q
  git add -A
  git -c user.name=smoke -c user.email=smoke@test commit -qm 'Seed hello-aflt'
)

LOOP_JSON="$WORK/.agentfleet/loop.json"
VALIDATE_OUT="$(mktemp)"
if ! node "$AFLT_BIN" --space "$SPACE_NAME" loop validate "$LOOP_JSON" --json >"$VALIDATE_OUT" 2>&1; then
  echo LOOP-FAIL
  cat "$VALIDATE_OUT"
  exit 1
fi
if grep -q 'outside the project' "$VALIDATE_OUT"; then
  echo LOOP-FAIL
  echo "validate warned about files outside cwd:" >&2
  cat "$VALIDATE_OUT" >&2
  exit 1
fi

set +e
node "$AFLT_BIN" --space "$SPACE_NAME" loop run "$LOOP_JSON" --json
RUN_CODE=$?
set -e

STATUS_OUT="$(mktemp)"
node "$AFLT_BIN" --space "$SPACE_NAME" loop status hello-aflt --json >"$STATUS_OUT" 2>&1 || true
STATUS="$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log(j.status||j.loop?.status||'unknown')" "$STATUS_OUT" 2>/dev/null || echo unknown)"
EVAL_SCORE="$(node -e "
const fs=require('fs');
try {
  const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  const phases=j.phases||j.pipeline||[];
  let best=null;
  for (const p of (Array.isArray(phases)?phases:Object.values(phases))) {
    if (p&&p.evalScore!=null) best=p.evalScore;
  }
  if (best!=null) console.log(best);
} catch(_){}
" "$STATUS_OUT" 2>/dev/null || true)"

if [[ "$RUN_CODE" -eq 0 && "$STATUS" == "completed" ]]; then
  echo LOOP-OK
else
  echo LOOP-FAIL
fi
echo "final_status=$STATUS"
echo "eval_score=${EVAL_SCORE:-n/a}"
echo "loop_run_exit=$RUN_CODE"
exit "$RUN_CODE"