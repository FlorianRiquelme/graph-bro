/**
 * Vitest `setupFiles`: cuts the operator's own git configuration out of every
 * test process, so the suite tests this repo's behavior rather than the
 * machine it runs on.
 *
 * This is not hypothetical tidiness. The scratch-directory exclusion (R10) was
 * "verified" locally against a global gitignore that happened to contain
 * `.claude/`, so a mechanism that never worked at all looked correct on the
 * dev machine and failed deterministically on CI — the exact false-green a
 * blocking gate exists to prevent. Any assertion about ignore rules, signing,
 * hooks, or default branch names is vulnerable the same way.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` (git >= 2.32) are the supported way
 * to do this; `/dev/null` reads as an empty config file. Set here rather than
 * in each test's spawned-process env because the suite shells out to git from
 * many places — helpers, fixtures, and the CLI subprocesses that inherit this
 * environment.
 *
 * Neutralising the global config is NOT sufficient on its own, and getting
 * this half-right is what hid the bug above for a whole review cycle: with no
 * `core.excludesFile` configured, git falls back to `$XDG_CONFIG_HOME/git/ignore`
 * (`~/.config/git/ignore`). This operator's copy carries a recursive-glob rule
 * for `.claude/settings.local.json` — the exact path the scratch-directory
 * test creates — so the assertion passed locally no matter what the code did.
 * `GIT_CONFIG_COUNT`/`KEY`/`VALUE` inject the setting with `-c` precedence,
 * which is the only way to force the fallback off as well.
 */
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.excludesFile";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";
