#!/usr/bin/env node
/**
 * Secret scan.
 *
 * Scans what git would actually publish — tracked files, plus untracked files
 * that are NOT ignored — for material that must never leave a machine. Scanning
 * the working tree instead would flag `.wallets.json` and `.dev.vars` every time,
 * which are exactly the files that are supposed to exist locally and never be
 * committed. What matters is whether git can see them.
 *
 *   node scripts/secret-scan.mjs            # what a commit would publish
 *   node scripts/secret-scan.mjs --history  # also every blob ever committed
 *
 * Exit code 1 on any finding. Matched values are NEVER printed.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const HISTORY = process.argv.includes("--history");

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return "";
  }
};

/**
 * Patterns for material that is secret by construction.
 *
 * A Supabase anon/publishable key is deliberately absent: it is designed to ship
 * in a browser bundle, RLS bounds what it can read, and flagging it would train
 * everyone to ignore this tool. The service-role key is a different object and is
 * matched by its `"role":"service_role"` payload.
 */
const RULES = [
  // A private key and a bytes32 market id are both 32 random-looking bytes. They
  // CANNOT be told apart by looking at the value, so this rule keys on the name
  // the value is bound to instead. Every real leak has a name attached — nobody
  // commits a bare key with no variable — and a market id never sits behind one
  // of these words.
  {
    id: "secret-value-64-hex",
    re: /\b\w*(?:priv(?:ate)?|secret|mnemonic|seed|signer|wallet|deployer|owner|agent)\w*(?:_?key)?\b\s*[:=]\s*["'`]?(?:0x)?[0-9a-fA-F]{64}\b/gi,
    why: "32-byte value bound to a secret-sounding name",
  },
  {
    id: "secret-value-hex-generic",
    // The negative lookahead skips a plain EVM address, which is what keeps
    // public contract addresses like `outcomeToken` out of the results.
    re: /\b\w*(?:api_?key|access_?key|service_?role|auth|password|passwd|credential|bearer|token|_key)\w*\b\s*[:=]\s*["'`]?(?!0x[0-9a-fA-F]{40}\b)[A-Za-z0-9_\-+/=.]{24,}/gi,
    why: "long value bound to a credential-sounding name",
  },
  // A mnemonic in a file is a value, not prose: quoted, or on the right of an
  // `=`, or in a JSON field. Matching a bare run of lowercase words instead
  // flags every English paragraph in the documentation, which trains everyone
  // to ignore this tool.
  {
    id: "mnemonic",
    re: /(?:["'`]|=\s*|:\s*)(?:[a-z]{3,8} ){11,23}[a-z]{3,8}(?:["'`]|\s*$)/g,
    why: "12 to 24 word phrase used as a value",
  },
  { id: "supabase-service-role", re: /"role"\s*:\s*"service_role"/g, why: "Supabase service-role JWT payload" },
  // Decoded below rather than matched here: a JWT's payload is base64, so the
  // role never appears literally in the file.
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, why: "JSON Web Token", decode: true },
  { id: "supabase-secret-key", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g, why: "Supabase secret key" },
  { id: "cloudflare-token", re: /\b[A-Za-z0-9_-]{40}\b(?=.*(?:CLOUDFLARE|CF_API))/gi, why: "Cloudflare API token" },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, why: "AWS access key id" },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9]{32,}\b/g, why: "OpenAI-style secret key" },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, why: "GitHub token" },
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, why: "PEM private key" },
  { id: "postgres-url-with-password", re: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@/g, why: "Postgres URL with an inline password" },
];

/**
 * Values that match a rule but are not secrets.
 *
 * A bytes32 is 64 hex characters, and this codebase is full of them: market ids,
 * domain hashes, policy hashes, intent hashes, transaction hashes, keccak
 * constants. They are public chain data. Without these exemptions the scan is
 * pure noise and stops being read.
 */
const ALLOW = [
  /[:=]\s*["'`]?(?:0x)?0+["'`]?$/,   // bound to a zero word
  /[:=]\s*["'`]?(?:0x)?[0-9a-fA-F]*0{20,}/, // bound to an ABI-padded word
  /\bprocess\.env\b/,               // reading a secret from the environment
  /\bexample\b|\bplaceholder\b|\byour[-_]/i,
];

const CONTEXT_ALLOW = [
  /marketId|market_id|domain|Hash|hash|txHash|tx_hash|salt|keccak|topic|selector|intentHash|orderKey|strategyVersion|blockHash|_LOCK/,
  // Public by design: the anon / publishable key ships in the browser bundle and
  // RLS bounds what it can read. The service-role key is a different object and
  // is caught by decoding the JWT, not by its variable name.
  /ANON_KEY|PUBLISHABLE_KEY|anonKey|publishableKey|supabaseAnonKey/,
];

/**
 * A Supabase key IS a JWT, so the only honest test is to read its role claim.
 * Returns true when the token is a secret one.
 */
function jwtIsSecret(token) {
  const payload = token.split(".")[1];
  if (!payload) return false;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json);
    return typeof claims.role === "string" && claims.role !== "anon";
  } catch {
    // Undecodable: treat as suspicious rather than waving it through.
    return true;
  }
}

/**
 * Files that must never be tracked at all, whatever they contain.
 *
 * Content matching is a backstop. The primary control is that these files are
 * ignored, so their PRESENCE in git's publishable set is itself the finding.
 */
const FORBIDDEN_PATH =
  /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|\.wallets\.json|.*\.(key|pem|keystore)|mnemonic.*|secrets?\..*|service-role.*)$/i;

const ALLOWED_EXAMPLES = /\.(example|sample|template)$/i;

/** Paths whose contents are chain data or documentation of it, not credentials. */
const SKIP_PATH =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|node_modules|\.git|out|cache|lib|dist|broadcast|coverage)(\/|$)|\.(png|jpg|jpeg|gif|svg|ico|woff2?|pdf|wasm)$/;

// This file necessarily contains the patterns it looks for.
const SELF = "scripts/secret-scan.mjs";

const looksBinary = (buf) => buf.includes(0);

function scanText(path, text) {
  const findings = [];
  const lines = text.split("\n");

  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length > 4000) continue;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const value = m[0];
        if (ALLOW.some((a) => a.test(value))) continue;
        if (CONTEXT_ALLOW.some((c) => c.test(line))) continue;
        if (rule.decode && !jwtIsSecret(value)) continue;
        findings.push({ path, line: i + 1, rule: rule.id, why: rule.why });
        break; // one finding per rule per file is enough to fail
      }
      if (findings.some((f) => f.rule === rule.id && f.path === path)) break;
    }
  }
  return findings;
}

// --- what a commit would publish --------------------------------------------

const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
const untrackedUnignored = git("ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean);
const candidates = [...new Set([...tracked, ...untrackedUnignored])].filter(
  (p) => !SKIP_PATH.test(p) && p !== SELF,
);

const findings = [];
for (const path of candidates) {
  if (FORBIDDEN_PATH.test(path) && !ALLOWED_EXAMPLES.test(path)) {
    findings.push({ path, line: 0, rule: "forbidden-path", why: "this file must never be tracked" });
    continue;
  }
  let buf;
  try {
    buf = fs.readFileSync(path);
  } catch {
    continue;
  }
  if (looksBinary(buf)) continue;
  findings.push(...scanText(path, buf.toString("utf8")));
}

// --- optionally, everything ever committed ----------------------------------

let historyScanned = 0;
if (HISTORY) {
  const objects = git("rev-list", "--objects", "--all")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sp = l.indexOf(" ");
      return sp === -1 ? null : { sha: l.slice(0, sp), path: l.slice(sp + 1) };
    })
    .filter((o) => o && o.path && !SKIP_PATH.test(o.path) && o.path !== SELF);

  for (const o of objects) {
    const content = git("cat-file", "-p", o.sha);
    if (!content) continue;
    historyScanned += 1;
    findings.push(...scanText(`${o.path}@${o.sha.slice(0, 8)}`, content));
  }
}

// --- report ------------------------------------------------------------------

console.log(`scanned ${candidates.length} publishable files${HISTORY ? ` and ${historyScanned} historical blobs` : ""}`);

if (findings.length === 0) {
  console.log("no secrets found");
  process.exit(0);
}

console.error(`\n${findings.length} finding${findings.length === 1 ? "" : "s"} — values deliberately not printed:\n`);
for (const f of findings) console.error(`  ${f.path}:${f.line}  [${f.rule}]  ${f.why}`);
console.error("\nIf a finding is real: rotate the credential FIRST, then remove it. See SECURITY.md.");
process.exit(1);
