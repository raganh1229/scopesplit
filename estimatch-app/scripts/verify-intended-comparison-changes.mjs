#!/usr/bin/env node
import { execSync } from 'node:child_process';

const SENSITIVE_COMPARISON_PATTERNS = [
  'app/api/comparisons/**',
  'app/app/comparison/**',
  'lib/comparison-processing.ts',
  'lib/comparison-line-filter.ts',
  'lib/deterministic-prematch.ts',
  'lib/pdf-vision-extract.ts',
  'lib/zone-reconciliation.ts',
  'lib/pair-edits/**',
];

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(glob) {
  const normalized = glob.replace(/\\/g, '/');
  const tokenized = normalized
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '__SINGLE_STAR__');

  const escaped = escapeRegex(tokenized)
    .replace(/__DOUBLE_STAR__/g, '.*')
    .replace(/__SINGLE_STAR__/g, '[^/]*');

  return new RegExp(`^${escaped}$`);
}

function runGit(command) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isGitRepository() {
  try {
    runGit('git rev-parse --is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = {
    baseRef: 'HEAD',
    allow: [],
    printChanged: false,
    changedFiles: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];

    if (current === '--base') {
      args.baseRef = argv[i + 1] ?? 'HEAD';
      i += 1;
      continue;
    }

    if (current === '--allow') {
      const pattern = argv[i + 1];
      if (pattern) {
        args.allow.push(pattern);
      }
      i += 1;
      continue;
    }

    if (current === '--print-changed') {
      args.printChanged = true;
    }

    if (current === '--changed-file') {
      const file = argv[i + 1];
      if (file) {
        args.changedFiles.push(file.replace(/\\/g, '/'));
      }
      i += 1;
    }
  }

  return args;
}

function getChangedFiles(baseRef) {
  const tracked = runGit(`git diff --name-only --diff-filter=ACMR ${baseRef} --`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const untracked = runGit('git ls-files --others --exclude-standard')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return Array.from(new Set([...tracked, ...untracked])).map((file) => file.replace(/\\/g, '/'));
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globToRegex(pattern).test(path));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const changedFiles = (() => {
    if (args.changedFiles.length > 0) {
      return Array.from(new Set(args.changedFiles));
    }

    if (isGitRepository()) {
      return getChangedFiles(args.baseRef);
    }

    console.error(
      'FAIL: no git repository detected. Provide explicit files with --changed-file <path>.'
    );
    process.exit(1);
  })();

  if (args.printChanged) {
    console.log('Changed files:');
    changedFiles.forEach((file) => console.log(`- ${file}`));
  }

  const sensitiveTouched = changedFiles.filter((file) => matchesAny(file, SENSITIVE_COMPARISON_PATTERNS));

  if (sensitiveTouched.length === 0) {
    console.log('PASS: no comparison-sensitive files changed.');
    return;
  }

  if (args.allow.length === 0) {
    console.error('FAIL: comparison-sensitive files changed, but no --allow patterns were provided.');
    console.error('Touched sensitive files:');
    sensitiveTouched.forEach((file) => console.error(`- ${file}`));
    process.exit(1);
  }

  const unauthorized = sensitiveTouched.filter((file) => !matchesAny(file, args.allow));

  if (unauthorized.length > 0) {
    console.error('FAIL: unauthorized comparison-sensitive changes detected.');
    console.error('Allowed patterns:');
    args.allow.forEach((pattern) => console.error(`- ${pattern}`));
    console.error('Unauthorized files:');
    unauthorized.forEach((file) => console.error(`- ${file}`));
    process.exit(1);
  }

  console.log('PASS: only explicitly allowed comparison-sensitive files were changed.');
}

main();
