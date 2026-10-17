# cotext

## Setup outside the repo

`install.sh` sets up everything cotext needs outside this repo: the link
under `~/.claude/skills`, `.review/` in git's global ignore, the node check,
and the `/config` options. When a feature needs something new out there,
such as a file under `~/.claude`, a setting, a `/config` option, a tool on the
PATH or a git config, add it to `install.sh` in the same change. Keep it safe
to run again: each step checks before it changes anything. If the change
should be undone on uninstall, update `--uninstall` too, and update the
closing "Done." message when the person has something new to know.
