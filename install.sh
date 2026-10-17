#!/usr/bin/env bash
# Installs cotext for every Claude Code session: what it needs outside this repo.
#
#   ./install.sh                 link the mod, ignore .review/ in git, check node
#   ./install.sh --no-gitignore  the same, leaving git's global ignore alone
#   ./install.sh --uninstall     remove the link (and nothing else)
#
# Safe to run again: each step checks before it changes anything.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILLS="$HOME/.claude/skills"
LINK="$SKILLS/cotext"
NODE_MAJOR=18

GITIGNORE=1
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-gitignore) GITIGNORE=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1" >&2; exit 1; }

# Whether $LINK is a link to this repo.
links_here() { [ -L "$LINK" ] && [ "$(cd "$LINK" && pwd -P)" = "$REPO" ]; }

if [ "$UNINSTALL" = 1 ]; then
  echo "Removing cotext"
  if links_here; then
    rm "$LINK"
    ok "removed $LINK"
  elif [ -e "$LINK" ]; then
    fail "$LINK is not a link to $REPO; left as it is"
  else
    ok "$LINK was not there"
  fi
  echo "Restart open Claude Code sessions to unload it."
  exit 0
fi

echo "Installing cotext from $REPO"

# 1. Claude Code, which loads the mod.
command -v claude >/dev/null || fail "claude is not on the PATH: install Claude Code first"
ok "claude $(claude --version 2>/dev/null | head -1)"

# 2. node, which serves the review page (server/server.mjs).
command -v node >/dev/null || fail "node is not on the PATH: the review page needs Node.js $NODE_MAJOR or newer"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge "$NODE_MAJOR" ] || fail "node $(node --version) is too old: the review page needs $NODE_MAJOR or newer"
ok "node $(node --version) at $(command -v node)"
case "$(command -v node)" in
  */.nvm/* | */.fnm/* | */.volta/* | */.asdf/*)
    warn "node comes from a version manager: start Claude Code from a shell where it is on the PATH" ;;
esac

# 3. The link that makes every session load the mod, as cotext@skills-dir.
mkdir -p "$SKILLS"
if links_here; then
  ok "$LINK already links here"
elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
  fail "$LINK exists and is not a link to $REPO: move it away and run again"
else
  ln -s "$REPO" "$LINK"
  ok "linked $LINK → $REPO"
fi

# 4. The review journals each project gets under .review/ stay out of git.
if [ "$GITIGNORE" = 1 ]; then
  ignore="$(git config --global core.excludesFile || true)"
  ignore="${ignore/#\~/$HOME}"
  [ -n "$ignore" ] || ignore="${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore"
  if [ -f "$ignore" ] && grep -qxF '.review/' "$ignore"; then
    ok ".review/ already ignored in $ignore"
  else
    mkdir -p "$(dirname "$ignore")"
    printf '\n# cotext review journals\n.review/\n' >>"$ignore"
    ok "added .review/ to $ignore"
  fi
fi

# 5. Claude Code sees it.
if claude plugin list 2>/dev/null | grep -q 'cotext@skills-dir'; then
  ok "claude plugin list shows cotext@skills-dir"
else
  fail "claude plugin list does not show cotext@skills-dir"
fi

# 6. The /config rows: each set on when unset, a choice already made kept.
#    reviewPlans       "Revisar o plano no cotext"
#    planInstructions  "Instruções de plano do cotext"
options="$(claude plugin configure cotext@skills-dir --json 2>/dev/null || true)"
for field in reviewPlans planInstructions; do
  state="$(printf '%s' "$options" | FIELD="$field" node -e '
    let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
      const field = process.env.FIELD
      try {
        const o = JSON.parse(s)
        console.log(o.unconfigured?.includes(field) ? "unset" : o.inputs?.[field] ?? "unknown")
      } catch { console.log("unknown") }
    })')"
  case "$state" in
    unset)
      printf '{"%s":"true"}' "$field" | claude plugin configure cotext@skills-dir --values-stdin >/dev/null
      ok "$field on (/config)" ;;
    true) ok "$field already on (/config)" ;;
    false) warn "$field is off; /config turns it on" ;;
    *) warn "could not read cotext's option $field; /config shows it" ;;
  esac
done

# Loaded by the link now, the mod would load twice with --plugin-dir too.
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.bash_profile"; do
  if [ -f "$rc" ] && grep -q -- "--plugin-dir[ =]*[^ ]*cotext" "$rc"; then
    warn "$rc passes --plugin-dir for cotext: drop it, the link loads it already"
  fi
done

cat <<'EOF'

Done. Restart open Claude Code sessions, then:
  /cotext <file>        review a file in the browser
  /cotext plan          review the session's plan
  /config               turn the plan review and the plan instructions on or off

Plan instructions: .claude/cotext/plan-instructions.md in a project, else
~/.claude/cotext/plan-instructions.md, else cotext's defaults/plan-instructions.md.
EOF
