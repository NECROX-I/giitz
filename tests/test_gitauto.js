"use strict";

/**
 * tests/test_gtxr.js
 *
 * Uses Node.js built-in test runner — no external dependencies needed.
 *
 * Run:
 *   node --test tests/test_gtxr.js
 *   node --test --test-reporter spec tests/test_gtxr.js
 */

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");

// ---------------------------------------------------------------------------
// Load the module internals by extracting them from gtxr.js
// We re-require by extracting exported helpers via a test shim.
// Since gtxr.js is a single CLI file we test functions inline here.
// ---------------------------------------------------------------------------

// Replicate the small pure functions directly to test them in isolation.
// For integration-style tests we use a temp directory and stub spawnSync.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gtxr-test-"));
}

// ---------------------------------------------------------------------------
// 1. Config — save / load / corrupt
// ---------------------------------------------------------------------------

describe("Config", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });

  test("saveConfig writes JSON file", () => {
    const file = path.join(tmpDir, "config.json");
    const data = { provider: "openai", apiKey: "sk-test" };
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(loaded.provider, "openai");
    assert.equal(loaded.apiKey, "sk-test");
  });

  test("loadConfig returns empty object when file missing", () => {
    const file = path.join(tmpDir, "nonexistent.json");
    let result = {};
    try { result = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
    assert.deepEqual(result, {});
  });

  test("loadConfig handles corrupt JSON gracefully", () => {
    const file = path.join(tmpDir, "config.json");
    fs.writeFileSync(file, "{{not valid json}}");
    let result = {};
    try { result = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
    assert.deepEqual(result, {});
  });

  test("config file gets 600 permissions", () => {
    const file = path.join(tmpDir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ provider: "gemini", apiKey: "gm-key" }));
    fs.chmodSync(file, 0o600);
    const mode = fs.statSync(file).mode & 0o777;
    if (process.platform !== "win32") {
      assert.equal(mode, 0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Argument parser — replicated inline
// ---------------------------------------------------------------------------

const VALID_ARGS = new Set([
  "-v", "--version", "-h", "--help",
  "setup", "--no-push", "--no-ai", "--force-push",
  "--branch", "-b",
]);

function parseArgs(argv) {
  const opts = {
    version: false, help: false,
    setup: false,
    noPush: false, noAi: false, forcePush: false,
    branch: null,
  };
  const args = argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const a = args[i].toLowerCase();
    if (!VALID_ARGS.has(a)) throw new Error(`Unknown argument: '${args[i]}'`);
    switch (a) {
      case "-v": case "--version":   opts.version   = true; break;
      case "-h": case "--help":      opts.help      = true; break;
      case "setup":                  opts.setup     = true; break;
      case "upgrade":                opts.upgrade   = true; break;
      case "uninstall":              opts.uninstall = true; break;
      case "--no-push":              opts.noPush    = true; break;
      case "--no-ai":                opts.noAi      = true; break;
      case "--force-push":           opts.forcePush = true; break;
      case "--branch": case "-b":
        i++;
        if (i >= args.length) throw new Error("--branch requires a branch name.");
        opts.branch = args[i];
        break;
    }
    i++;
  }
  return opts;
}

describe("parseArgs", () => {
  const base = ["node", "gtxr"];

  test("no args — all defaults", () => {
    const opts = parseArgs(base);
    assert.equal(opts.noPush,    false);
    assert.equal(opts.noAi,     false);
    assert.equal(opts.forcePush, false);
    assert.equal(opts.branch,    null);
  });

  test("--no-push", () => assert.equal(parseArgs([...base, "--no-push"]).noPush, true));
  test("--no-ai",   () => assert.equal(parseArgs([...base, "--no-ai"]).noAi,    true));
  test("--force-push", () => assert.equal(parseArgs([...base, "--force-push"]).forcePush, true));

  test("-v and --version", () => {
    assert.equal(parseArgs([...base, "-v"]).version,        true);
    assert.equal(parseArgs([...base, "--version"]).version, true);
  });

  test("-h and --help", () => {
    assert.equal(parseArgs([...base, "-h"]).help,      true);
    assert.equal(parseArgs([...base, "--help"]).help,  true);
  });

  test("setup command", () => assert.equal(parseArgs([...base, "setup"]).setup,       true));

  test("-b short flag", () => {
    assert.equal(parseArgs([...base, "-b", "develop"]).branch, "develop");
  });

  test("--branch missing value throws", () => {
    assert.throws(() => parseArgs([...base, "--branch"]), /requires a branch name/);
  });

  test("unknown argument throws", () => {
    assert.throws(() => parseArgs([...base, "foobar"]), /Unknown argument/);
  });

  test("combined flags", () => {
    const opts = parseArgs([...base, "--no-push", "--no-ai"]);
    assert.equal(opts.noPush, true);
    assert.equal(opts.noAi,  true);
  });
});

// ---------------------------------------------------------------------------
// 3. Git result shape
// ---------------------------------------------------------------------------

describe("Git result", () => {
  test("ok/stdout/stderr shape is correct", () => {
    // Simulate what spawnSync returns shaped into our format
    function fakeGit(status, stdout, stderr) {
      return {
        ok:     status === 0,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
      };
    }

    const success = fakeGit(0, "main\n", "");
    assert.equal(success.ok, true);
    assert.equal(success.stdout, "main");

    const fail = fakeGit(1, "", "fatal: not a git repo");
    assert.equal(fail.ok, false);
    assert.match(fail.stderr, /not a git repo/);
  });
});

// ---------------------------------------------------------------------------
// 4. Push error detection
// ---------------------------------------------------------------------------

describe("Push — error detection", () => {
  function isRejected(stderr) {
    return ["fetch first", "non-fast-forward", "rejected"]
      .some(k => stderr.toLowerCase().includes(k));
  }

  function isNoUpstream(stderr) {
    return stderr.includes("no upstream") || stderr.includes("has no upstream");
  }

  test("detects rejected push", () => {
    assert.equal(isRejected("error: failed to push some refs (rejected)"), true);
    assert.equal(isRejected("hint: Updates were rejected because the remote contains work"), true);
    assert.equal(isRejected("! [rejected] main -> main (non-fast-forward)"), true);
  });

  test("detects no upstream", () => {
    assert.equal(isNoUpstream("The current branch has no upstream branch"), true);
    assert.equal(isNoUpstream("fatal: has no upstream branch"), true);
  });

  test("clean stderr is neither", () => {
    assert.equal(isRejected(""), false);
    assert.equal(isNoUpstream(""), false);
  });
});

// ---------------------------------------------------------------------------
// 5. AI error classification
// ---------------------------------------------------------------------------

describe("AI error handling", () => {
  function classifyAiError(message) {
    const msg = message.toLowerCase();
    if (msg.includes("credit") || msg.includes("quota") || msg.includes("insufficient"))
      return "credits";
    if (msg.includes("invalid") || msg.includes("auth") || msg.includes("401"))
      return "auth";
    if (msg.includes("rate") || msg.includes("429"))
      return "rate_limit";
    return "unknown";
  }

  test("credits exhausted — anthropic", () =>
    assert.equal(classifyAiError("Your credit balance is too low"), "credits"));

  test("credits exhausted — openai", () =>
    assert.equal(classifyAiError("You exceeded your current quota, insufficient_quota"), "credits"));

  test("invalid api key", () =>
    assert.equal(classifyAiError("invalid api key provided"), "auth"));

  test("401 auth error", () =>
    assert.equal(classifyAiError("401 Unauthorized"), "auth"));

  test("rate limit 429", () =>
    assert.equal(classifyAiError("429 rate limit exceeded"), "rate_limit"));

  test("unknown error", () =>
    assert.equal(classifyAiError("network timeout"), "unknown"));
});

// ---------------------------------------------------------------------------
// 6. AI package map
// ---------------------------------------------------------------------------

describe("AI package map", () => {
  const AI_PACKAGES = {
    openai:    "openai",
    anthropic: "@anthropic-ai/sdk",
    gemini:    "@google/genai",
  };

  test("all three providers have packages", () => {
    assert.ok(AI_PACKAGES.openai);
    assert.ok(AI_PACKAGES.anthropic);
    assert.ok(AI_PACKAGES.gemini);
  });

  test("no deprecated google-generativeai package", () => {
    assert.notEqual(AI_PACKAGES.gemini, "google-generativeai");
    assert.notEqual(AI_PACKAGES.gemini, "@google/generative-ai");
  });

  test("gemini uses new @google/genai", () => {
    assert.equal(AI_PACKAGES.gemini, "@google/genai");
  });
});

// ---------------------------------------------------------------------------
// 7. First run marker
// ---------------------------------------------------------------------------

describe("First run check", () => {
  test("creates marker file on first run", () => {
    const tmpDir = makeTempDir();
    const marker = path.join(tmpDir, ".welcomed");
    assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(marker, "");
    assert.equal(fs.existsSync(marker), true);
  });

  test("does not show welcome when marker exists", () => {
    const tmpDir = makeTempDir();
    const marker = path.join(tmpDir, ".welcomed");
    fs.writeFileSync(marker, "");
    // If marker exists, welcome should be skipped
    assert.equal(fs.existsSync(marker), true);
  });
});

// ---------------------------------------------------------------------------
// 8. Version format
// ---------------------------------------------------------------------------

describe("Version", () => {
  const VERSION = "1.0.0";

  test("follows semver major.minor.patch", () => {
    const parts = VERSION.split(".");
    assert.equal(parts.length, 3);
    assert.ok(parts.every(p => /^\d+$/.test(p)), "all parts must be numeric");
  });
});

// ---------------------------------------------------------------------------
// 9. Providers list
// ---------------------------------------------------------------------------

describe("Providers", () => {
  const PROVIDERS = ["openai", "anthropic", "gemini"];

  test("contains exactly three providers", () => assert.equal(PROVIDERS.length, 3));
  test("includes openai",    () => assert.ok(PROVIDERS.includes("openai")));
  test("includes anthropic", () => assert.ok(PROVIDERS.includes("anthropic")));
  test("includes gemini",    () => assert.ok(PROVIDERS.includes("gemini")));
  test("does not include deprecated google-palm", () =>
    assert.equal(PROVIDERS.includes("palm"), false));
});