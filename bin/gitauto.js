#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const readline = require("readline");

// ---------------------------------------------------------------------------
// Version & constants
// ---------------------------------------------------------------------------
const VERSION        = "1.0.1";
const CONFIG_DIR     = path.join(os.homedir(), ".giitz");
const CONFIG_FILE    = path.join(CONFIG_DIR, "config.json");
const WELCOME_MARKER = path.join(CONFIG_DIR, ".welcomed");
const AI_MODULES_DIR = path.join(CONFIG_DIR, "node_modules");

const PROVIDERS = ["openai", "anthropic", "gemini"];

const AI_PACKAGES = {
  openai:    "openai",
  anthropic: "@anthropic-ai/sdk",
  gemini:    "@google/genai",
};

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[91m",
  green:  "\x1b[92m",
  yellow: "\x1b[93m",
  cyan:   "\x1b[96m",
  purple: "\x1b[95m",
};

const ok   = (msg) => console.log(`${C.green}✓  ${msg}${C.reset}`);
const info = (msg) => console.log(`${C.cyan}ℹ  ${msg}${C.reset}`);
const warn = (msg) => console.log(`${C.yellow}⚠  ${msg}${C.reset}`);
const err  = (msg) => console.log(`${C.red}✗  ${msg}${C.reset}`);

function header(text) {
  const bar = "═".repeat(34);
  console.log(`\n${C.purple}${C.bold}  ╔${bar}╗${C.reset}`);
  console.log(`${C.purple}${C.bold}  ║ ${text.padEnd(33)}║${C.reset}`);
  console.log(`${C.purple}${C.bold}  ╚${bar}╝${C.reset}\n`);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE))
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (_) {}
  return {};
}

function saveConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
function git(...args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return {
    ok:     r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

function isGitRepo()        { return git("rev-parse", "--git-dir").ok; }
function getStatus()        { const r = git("status", "--short"); return r.ok ? r.stdout : ""; }
function getCurrentBranch() { const r = git("branch", "--show-current"); return r.ok && r.stdout ? r.stdout : "main"; }
function getRemoteUrl()     { const r = git("remote", "get-url", "origin"); return r.ok ? r.stdout : "No remote configured"; }

function getDiff() {
  const staged = git("diff", "--cached");
  if (staged.ok && staged.stdout) return staged.stdout;
  const unstaged = git("diff");
  return unstaged.ok ? unstaged.stdout : "";
}

// ---------------------------------------------------------------------------
// AI — lazy install into ~/.giitz/node_modules
// ---------------------------------------------------------------------------
function ensureAiPackage(provider) {
  const pkg     = AI_PACKAGES[provider];
  const pkgPath = path.join(AI_MODULES_DIR, pkg.split("/")[0]);

  if (fs.existsSync(pkgPath)) return;

  info(`Installing ${pkg}...`);
  fs.mkdirSync(AI_MODULES_DIR, { recursive: true });

  const r = spawnSync(
    "npm", ["install", "--prefix", CONFIG_DIR, "--no-save", "--loglevel", "error", pkg],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }
  );

  if (r.status !== 0)
    throw new Error(`Failed to install ${pkg}:\n${r.stderr}`);
}

// Errors worth retrying — transient server/network issues
function isRetryable(error) {
  const msg = (error.message || "").toLowerCase();
  const status = error.status || error.statusCode || 0;
  return (
    status === 503 || status === 502 || status === 529 ||
    msg.includes("503") || msg.includes("502") || msg.includes("overloaded") ||
    msg.includes("timeout") || msg.includes("econnreset") ||
    msg.includes("socket hang up") || msg.includes("network")
  );
}

// Errors NOT worth retrying — permanent failures
function isPermanent(error) {
  const msg = (error.message || "").toLowerCase();
  const status = error.status || error.statusCode || 0;
  return (
    status === 401 || status === 403 || status === 404 ||
    msg.includes("invalid") || msg.includes("auth") ||
    msg.includes("quota") || msg.includes("credit") ||
    msg.includes("insufficient")
  );
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAI(provider, apiKey, aiPrompt) {
  ensureAiPackage(provider);

  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 3000, 6000]; // 1s, 3s, 6s

  async function attempt() {
    if (provider === "openai") {
      const { OpenAI } = require(path.join(AI_MODULES_DIR, "openai"));
      const client = new OpenAI({ apiKey });
      const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: aiPrompt }],
        max_tokens: 60,
      });
      return res.choices[0].message.content.trim();
    }

    if (provider === "anthropic") {
      const Anthropic = require(path.join(AI_MODULES_DIR, "@anthropic-ai", "sdk"));
      const client = new (Anthropic.default || Anthropic)({ apiKey });
      const msg = await client.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        messages: [{ role: "user", content: aiPrompt }],
      });
      return msg.content[0].text.trim();
    }

    if (provider === "gemini") {
      const { GoogleGenAI } = require(path.join(AI_MODULES_DIR, "@google", "genai"));
      const ai  = new GoogleGenAI({ apiKey });
      const res = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: aiPrompt,
      });
      return res.text.trim();
    }

    throw new Error(`Unknown provider: ${provider}`);
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await attempt();
    } catch (error) {
      // Permanent error — no point retrying
      if (isPermanent(error)) throw error;

      // Retryable error — wait and try again
      if (isRetryable(error) && i < MAX_RETRIES - 1) {
        const delay = RETRY_DELAYS[i];
        warn(`AI service unavailable — retrying in ${delay / 1000}s... (${i + 1}/${MAX_RETRIES - 1})`);
        await sleep(delay);
        continue;
      }

      // Last attempt or unknown error — throw
      throw error;
    }
  }
}

function handleAiError(provider, error) {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("credit") || msg.includes("quota") || msg.includes("insufficient")) {
    err("AI API credits exhausted.");
    if (provider === "anthropic") info("Billing: https://console.anthropic.com/settings/billing");
    if (provider === "openai")    info("Billing: https://platform.openai.com/account/billing");
    info("Or skip AI:  giitz --no-ai");
  } else if (msg.includes("invalid") || msg.includes("auth") || msg.includes("401")) {
    err("Invalid API key.");
    info("Reconfigure: giitz setup");
  } else if (msg.includes("rate") || msg.includes("429")) {
    err("Rate limit hit. Wait a moment and retry.");
    info("Or skip AI:  giitz --no-ai");
  } else {
    err(`AI generation failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------
function push(branch, forcePush) {
  if (forcePush) {
    warn("Force pushing — this overwrites remote history.");
    const r = git("push", "--force", "origin", branch);
    if (r.ok) { ok(`Force-pushed to origin/${branch}`); return true; }
    err(`Force push failed: ${r.stderr}`);
    return false;
  }

  info(`Pushing to origin/${branch}...`);
  let r = git("push", "origin", branch);
  if (r.ok) { ok(`Pushed to origin/${branch}`); return true; }

  // New branch — set upstream
  if (r.stderr.includes("no upstream") || r.stderr.includes("has no upstream")) {
    info("New branch — setting upstream automatically...");
    r = git("push", "--set-upstream", "origin", branch);
    if (r.ok) { ok(`Pushed and upstream set for origin/${branch}`); return true; }
    err(`Failed to set upstream: ${r.stderr}`);
    return false;
  }

  // Rejected — auto rebase
  const rejected = ["fetch first", "non-fast-forward", "rejected"]
    .some(k => r.stderr.toLowerCase().includes(k));

  if (rejected) {
    info("Remote has new commits — rebasing automatically...");
    const rebase = git("pull", "--rebase", "origin", branch);
    if (!rebase.ok) {
      err("Auto-rebase failed — conflicts need manual resolution.");
      info("Your repo is in rebase state. To resolve:");
      info("  1. Fix conflict markers in affected files");
      info("  2. git add .");
      info("  3. git rebase --continue");
      info(`  4. git push origin ${branch}`);
      info("  Or to cancel: git rebase --abort");
      return false;
    }
    r = git("push", "origin", branch);
    if (r.ok) { ok(`Pushed to origin/${branch} after rebase.`); return true; }
    err(`Push failed after rebase: ${r.stderr}`);
    return false;
  }

  err(`Push failed: ${r.stderr}`);
  return false;
}

// ---------------------------------------------------------------------------
// Branch switching
// ---------------------------------------------------------------------------
function switchBranch(name) {
  let r = git("checkout", name);
  if (r.ok) { ok(`Switched to branch: ${name}`); return name; }

  info(`Branch '${name}' not found — creating it...`);
  r = git("checkout", "-b", name);
  if (r.ok) { ok(`Created and switched to: ${name}`); return name; }

  err(`Could not switch/create branch '${name}': ${r.stderr}`);
  return getCurrentBranch();
}

// ---------------------------------------------------------------------------
// First-run welcome
// ---------------------------------------------------------------------------
function firstRunCheck() {
  if (fs.existsSync(WELCOME_MARKER)) return;
  console.log(`
${C.green}${C.bold}  ╔══════════════════════════════════════╗${C.reset}
${C.green}${C.bold}  ║     GIITZ is ready to use!            ║${C.reset}
${C.green}${C.bold}  ╚══════════════════════════════════════╝${C.reset}

${C.cyan}  Available commands:${C.reset}
  ${C.bold}giitz${C.reset}                   Run full workflow  (add → commit → push)
  ${C.bold}giitz setup${C.reset}             Configure AI provider and API key
  ${C.bold}giitz --no-push${C.reset}         Commit only, skip push
  ${C.bold}giitz --no-ai${C.reset}           Skip AI, type message manually
  ${C.bold}giitz --force-push${C.reset}      Force push ${C.dim}(destructive)${C.reset}
  ${C.bold}giitz --branch <n>${C.reset}      Switch or create branch before committing
  ${C.bold}giitz --help${C.reset}            Show all commands

${C.cyan}  Upgrade:   ${C.bold}npm update -g @wizdomic/giitz${C.reset}
${C.cyan}  Uninstall: ${C.bold}npm uninstall -g @wizdomic/giitz${C.reset}

${C.yellow}  Get started:  giitz setup${C.reset}
`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WELCOME_MARKER, "");
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`
${C.purple}${C.bold}  ╔══════════════════════════════════════╗${C.reset}
${C.purple}${C.bold}  ║    GIITZ — AI Git Automation          ║${C.reset}
${C.purple}${C.bold}  ╚══════════════════════════════════════╝${C.reset}

${C.cyan}  Commands:${C.reset}
  giitz                     Run full workflow  (add → commit → push)
  giitz setup               Configure AI provider and API key

${C.cyan}  Options:${C.reset}
  --no-push                Commit only, skip push
  --no-ai                  Skip AI, enter message manually
  --force-push             Force push  (destructive)
  --branch, -b <n>         Switch or create branch before committing
  -v, --version            Print current version
  -h, --help               Show this message

${C.cyan}  Manage:${C.reset}
  npm update -g @wizdomic/giitz     Upgrade to latest
  npm uninstall -g @wizdomic/giitz  Remove GIITZ

${C.cyan}  Examples:${C.reset}
  giitz                             Full AI-powered workflow
  giitz --no-push                   Commit only
  giitz --branch feature/login      Switch branch then commit and push
  giitz --no-ai                     Manual commit message

${C.yellow}  First time? Run: giitz setup${C.reset}
`);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
async function cmdSetup() {
  header("GIITZ Setup");
  const providerInput = await prompt(`Provider (${PROVIDERS.join("/")}): `);
  const provider = providerInput.toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    warn("Unrecognised provider. Skipped.");
    return;
  }
  const apiKey = await prompt(`API key for ${provider}: `);
  if (!apiKey) { warn("No API key entered. Skipped."); return; }
  saveConfig({ provider, apiKey });
  ok(`${provider} configured successfully.`);
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------
async function getCommitMessage(config, diff, noAi) {
  const useAi = config.apiKey && config.provider && !noAi;

  if (!useAi) {
    if (!noAi) warn("AI not configured — run: giitz setup");
    const msg = await prompt("Commit message: ");
    return msg || null;
  }

  const generate = await prompt("Generate commit message with AI? (y/n) [y]: ");
  if (generate && generate.toLowerCase() !== "y") {
    const msg = await prompt("Commit message: ");
    return msg || null;
  }

  if (!diff) {
    warn("No diff found — enter message manually.");
    const msg = await prompt("Commit message: ");
    return msg || null;
  }

  const aiPrompt =
    "Generate a very short (one-line, imperative tense, <=50 chars) " +
    "git commit message summarising the changes below:\n\n" +
    diff.slice(0, 3000);

  while (true) {
    info(`Generating via ${config.provider}...`);
    try {
      const msg = await callAI(config.provider, config.apiKey, aiPrompt);
      if (!msg) throw new Error("Empty response from AI.");

      if (msg.length > 72) warn("Commit message is long — consider shortening it.");
      console.log(`\n  ${C.green}${C.bold}${msg}${C.reset}\n`);
      const choice = (await prompt("Use this? (y / r=regenerate / m=manual) [y]: ")).toLowerCase() || "y";

      if (choice === "y" || choice === "") return msg;
      if (choice === "r") continue;
      if (choice === "m") {
        const manual = await prompt("Commit message: ");
        return manual || null;
      }
    } catch (e) {
      handleAiError(config.provider, e);
      info("Falling back to manual input.");
      const msg = await prompt("Commit message: ");
      return msg || null;
    }
  }
}

// ---------------------------------------------------------------------------
// Main workflow
// ---------------------------------------------------------------------------
async function run(opts) {
  header(`GIITZ v${VERSION}`);

  if (!isGitRepo()) {
    err("Not a git repository. Run 'git init' first.");
    process.exit(1);
  }

  info(`Remote : ${getRemoteUrl()}`);

  let branch = getCurrentBranch();
  if (opts.branch) branch = switchBranch(opts.branch);
  info(`Branch : ${branch}`);

  const status = getStatus();
  if (!status) {
    warn("No changes detected — nothing to commit.");
    process.exit(0);
  }

  console.log(`\n${C.cyan}Changes:${C.reset}\n${status}\n`);

  // Stage
  const filesInput = await prompt("Files to add (. for all) [.]: ");
  const files      = filesInput || ".";
  const addArgs    = files === "." ? ["."] : files.split(/\s+/);
  const addResult  = git("add", ...addArgs);
  if (!addResult.ok) {
    err(`Failed to stage files: ${addResult.stderr}`);
    process.exit(1);
  }
  ok(`Staged: ${files}`);

  // Guard — verify something was actually staged
  const staged = git("diff", "--cached", "--name-only");
  if (!staged.stdout) {
    warn("Nothing was staged — check your file paths.");
    process.exit(1);
  }

  // Commit message
  const config  = loadConfig();
  const diff    = getDiff();
  const message = await getCommitMessage(config, diff, opts.noAi);
  if (!message) {
    err("Commit message cannot be empty.");
    process.exit(1);
  }

  // Commit
  const commitResult = git("commit", "-m", message);
  if (!commitResult.ok) {
    err(`Commit failed: ${commitResult.stderr}`);
    process.exit(1);
  }
  ok(`Committed: ${message}`);

  // Push
  if (opts.noPush) {
    info("Skipping push (--no-push).");
    header("Done!");
    return;
  }

  const doPush = ((await prompt("Push to remote? (y/n) [y]: ")) || "y").toLowerCase() === "y";
  if (doPush) push(branch, opts.forcePush);

  header("Done!");
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------
const VALID_ARGS = new Set([
  "-v", "--version",
  "-h", "--help",
  "setup",
  "--no-push", "--no-ai", "--force-push",
  "--branch", "-b",
]);

function parseArgs(argv) {
  const opts = {
    version: false, help: false, setup: false,
    noPush: false, noAi: false, forcePush: false,
    branch: null,
  };

  const args = argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const a = args[i].toLowerCase();

    if (!VALID_ARGS.has(a)) {
      err(`Unknown argument: '${args[i]}'`);
      info("Run 'giitz --help' to see valid commands.");
      process.exit(1);
    }

    switch (a) {
      case "-v": case "--version":  opts.version   = true; break;
      case "-h": case "--help":     opts.help      = true; break;
      case "setup":                 opts.setup     = true; break;
      case "--no-push":             opts.noPush    = true; break;
      case "--no-ai":               opts.noAi      = true; break;
      case "--force-push":          opts.forcePush = true; break;
      case "--branch": case "-b":
        i++;
        if (i >= args.length) {
          err("--branch requires a branch name.");
          process.exit(1);
        }
        opts.branch = args[i];
        break;
    }
    i++;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
(async () => {
  const opts = parseArgs(process.argv);

  if (opts.version) { console.log(`GIITZ v${VERSION}`); process.exit(0); }
  if (opts.help)    { printHelp(); process.exit(0); }

  firstRunCheck();

  if (opts.setup) { await cmdSetup(); process.exit(0); }

  try {
    await run(opts);
  } catch (e) {
    err(`Unexpected error: ${e.message}`);
    process.exit(1);
  }
})();