import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fork-release.mjs", import.meta.url));
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const tag = "audio-release-test";
const repository = "qinggeng2015/immich";
const applicationId = "app.alextran.immich.audio";
const certificate =
  "eb356e414b2f8e38b238b89b8a2ebb0b5d7ff56939f30e6b794408d9758284ed";
const buildNumber = 3_040_001;
const serverImage = `ghcr.io/qinggeng2015/immich-server:${tag}`;
const mlImage = `ghcr.io/qinggeng2015/immich-machine-learning:${tag}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

const mock = String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
const runtimePath = process.env.MOCK_RUNTIME;
const runtime = fs.existsSync(runtimePath) ? JSON.parse(fs.readFileSync(runtimePath, 'utf8')) : {};
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ command, args }) + '\n');
const save = () => fs.writeFileSync(runtimePath, JSON.stringify(runtime));
const respond = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
const fail = (message) => { process.stderr.write(message); process.exit(1); };
if (command === 'git' && args.join(' ') === 'rev-list -n 1 ' + state.tag) respond(state.sha);
if (command === 'gh' && args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/git/ref/tags/')) {
    const index = runtime.tagCalls || 0;
    runtime.tagCalls = index + 1;
    save();
    const tags = state.remoteTags || [state.sha];
    respond({ object: { type: 'commit', sha: tags[Math.min(index, tags.length - 1)] } });
  }
  if (endpoint.endsWith('/releases?per_page=100') && args.includes('--paginate') && args.includes('--slurp')) {
    if (state.releaseError) fail('gh: simulated failure (HTTP ' + state.releaseError + ')');
    const release = runtime.release || state.release;
    if (state.releasePages) respond(state.releasePages);
    respond(release ? [[{ tag_name: state.tag, ...release }]] : [[]]);
  }
  if (endpoint.includes('/actions/workflows/fork-ci.yml/runs?')) respond({ workflow_runs: state.runs || [] });
}
if (command === 'gh' && args[0] === 'release') {
  if (args[1] === 'create') {
    runtime.release = { draft: true, target_commitish: state.sha, assets: [] };
    save();
    respond('created');
  }
  if (args[1] === 'upload') {
    const files = args.slice(args.indexOf('--clobber') + 1);
    runtime.release = runtime.release || state.release;
    runtime.release.assets = files.map(file => {
      const bytes = fs.readFileSync(file);
      return { name: path.basename(file), size: bytes.length, state: 'uploaded', digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') };
    });
    save();
    respond('uploaded');
  }
  if (args[1] === 'edit') {
    runtime.published = true;
    save();
    respond('published');
  }
}
if (command === 'docker' && args.slice(0, 3).join(' ') === 'buildx imagetools inspect') {
  const image = args.at(-1);
  if (args.includes('--raw')) respond({ manifests: ['amd64', 'arm64'].map(architecture => ({ platform: { os: 'linux', architecture } })) });
  if (args.includes('--format')) {
    const configs = Object.fromEntries(['amd64', 'arm64'].map(architecture => ['linux/' + architecture, { config: { Labels: {
      'org.opencontainers.image.revision': state.imageRevisions?.[image + '/' + architecture] || state.sha,
      'org.opencontainers.image.source': 'https://github.com/' + state.repository,
    } } }]));
    respond(configs);
  }
  respond('Name: ' + image + '\nDigest: sha256:' + crypto.createHash('sha256').update(image).digest('hex'));
}
fail('Unsupported mock command: ' + command + ' ' + args.join(' '));
`;

const fixture = (context, overrides = {}) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "immich-release-gate-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, "bin");
  const output = path.join(cwd, ".scratch/fork-release");
  const stateFile = path.join(cwd, "state.json");
  const runtimeFile = path.join(cwd, "runtime.json");
  const callsFile = path.join(cwd, "calls.jsonl");
  const githubOutput = path.join(cwd, "github-output");
  mkdirSync(bin);
  mkdirSync(output, { recursive: true });
  writeFileSync(callsFile, "");
  writeFileSync(githubOutput, "");
  writeFileSync(
    stateFile,
    JSON.stringify({ sha, tag, repository, ...overrides }),
  );
  for (const command of ["gh", "git", "docker"]) {
    const executable = path.join(bin, command);
    writeFileSync(executable, mock);
    chmodSync(executable, 0o755);
  }
  const env = {
    PATH: bin,
    MOCK_STATE: stateFile,
    MOCK_RUNTIME: runtimeFile,
    MOCK_CALLS: callsFile,
    RELEASE_TAG: tag,
    RELEASE_REPOSITORY: repository,
    RELEASE_SHA: sha,
    RELEASE_BUILD_NUMBER: String(buildNumber),
    RELEASE_SERVER_IMAGE: serverImage,
    RELEASE_ML_IMAGE: mlImage,
    GITHUB_REF: `refs/tags/${tag}`,
    GITHUB_OUTPUT: githubOutput,
    GITHUB_RUN_NUMBER: "1",
  };
  return {
    output,
    run: (operation) =>
      spawnSync(process.execPath, [script, operation], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 15_000,
      }),
    calls: () =>
      readFileSync(callsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    clearCalls: () => writeFileSync(callsFile, ""),
    githubOutput: () => readFileSync(githubOutput, "utf8"),
    write: (name, content) => writeFileSync(path.join(output, name), content),
    read: (name) => JSON.parse(readFileSync(path.join(output, name), "utf8")),
  };
};

const requireSuccess = (result) => {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

const requireFailure = (result, message) => {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
};

const releaseMutations = (calls) =>
  calls.filter(
    ({ command, args }) => command === "gh" && args[0] === "release",
  );

const createAssets = (state) => {
  const assets = Object.entries({
    "armeabi-v7a": 1000,
    "arm64-v8a": 2000,
    x86_64: 4000,
  }).map(([abi, offset]) => {
    const file = `immich-audio-${abi}.apk`;
    const bytes = Buffer.from(`Synthetic release artifact for ${abi}`);
    state.write(file, bytes);
    return {
      file,
      abi,
      applicationId,
      certificateSha256: certificate,
      versionCode: buildNumber + offset,
      bytes: bytes.length,
      sha256: digest(bytes),
    };
  });
  state.write(
    "android-manifest.json",
    JSON.stringify({
      commit: sha,
      applicationId,
      certificateSha256: certificate,
      assets,
    }),
  );
  for (const file of [
    "docker-compose.yml",
    "docker-compose.rootless.yml",
    "example.env",
    "INSTALL-zh.md",
    "immich-openapi-specs.json",
    "immich-sdk-3.4.0.tgz",
    "immich-cli-3.4.0.tgz",
  ]) {
    state.write(file, `Synthetic ${file}\n`);
  }
};

test("prepare refuses a published tag before authorizing any build", (context) => {
  const state = fixture(context, {
    release: { draft: false, target_commitish: sha, assets: [] },
  });
  requireFailure(state.run("prepare"), /already has a published release/);
  assert.equal(state.githubOutput(), "");
  assert.deepEqual(releaseMutations(state.calls()), []);
  assert(!state.calls().some(({ command }) => command === "docker"));
});

test("prepare fails closed on a non-404 release API error", (context) => {
  const state = fixture(context, { releaseError: 403 });
  requireFailure(state.run("prepare"), /HTTP 403/);
  assert.equal(state.githubOutput(), "");
  assert.deepEqual(releaseMutations(state.calls()), []);
});

test("prepare discovers an existing draft on a later release page", (context) => {
  const state = fixture(context, {
    releasePages: [
      [{ tag_name: "audio-another-release", draft: false }],
      [{ tag_name: tag, draft: true, target_commitish: sha, assets: [] }],
    ],
  });
  requireSuccess(state.run("prepare"));
  assert.match(state.githubOutput(), /^needs-checks=true$/m);
  assert.deepEqual(releaseMutations(state.calls()), []);
});

test("prepare rejects a published release on a later release page", (context) => {
  const state = fixture(context, {
    releasePages: [
      [{ tag_name: "audio-another-release", draft: true }],
      [{ tag_name: tag, draft: false, target_commitish: sha, assets: [] }],
    ],
  });
  requireFailure(state.run("prepare"), /already has a published release/);
  assert.equal(state.githubOutput(), "");
  assert.deepEqual(releaseMutations(state.calls()), []);
});

test("prepare reuses successful trusted checks for exactly the release SHA", (context) => {
  const state = fixture(context, {
    runs: [
      { head_sha: otherSha, conclusion: "success", event: "push" },
      {
        head_sha: sha,
        conclusion: "success",
        event: "workflow_dispatch",
        html_url: "https://example.invalid/checks/1",
      },
    ],
  });
  requireSuccess(state.run("prepare"));
  assert.match(state.githubOutput(), /^needs-checks=false$/m);
});

for (const run of [
  { head_sha: otherSha, conclusion: "success", event: "push" },
  { head_sha: sha, conclusion: "success", event: "pull_request" },
]) {
  test(`prepare requires checks for ${run.event} at ${run.head_sha === sha ? "the same" : "another"} SHA`, (context) => {
    const state = fixture(context, { runs: [run] });
    requireSuccess(state.run("prepare"));
    assert.match(state.githubOutput(), /^needs-checks=true$/m);
  });
}

test("manifest records a complete matching release and container digests", (context) => {
  const state = fixture(context);
  createAssets(state);
  requireSuccess(state.run("manifest"));
  const manifest = state.read("release-manifest.json");
  assert.equal(manifest.sha, sha);
  assert.equal(manifest.android.applicationId, applicationId);
  assert.deepEqual(Object.keys(manifest.images), [serverImage, mlImage]);
  assert(
    manifest.assets.some(({ name }) => name === "immich-audio-arm64-v8a.apk"),
  );
  assert(existsSync(path.join(state.output, "SHA256SUMS")));
});

test("manifest rejects an APK whose bytes differ from its declared hash", (context) => {
  const state = fixture(context);
  createAssets(state);
  const name = "immich-audio-arm64-v8a.apk";
  const bytes = readFileSync(path.join(state.output, name));
  bytes[0] ^= 1;
  state.write(name, bytes);
  requireFailure(state.run("manifest"), /AssertionError/);
  assert(!existsSync(path.join(state.output, "release-manifest.json")));
  assert.deepEqual(state.calls(), []);
});

test("manifest rejects metadata claiming the original Android package", (context) => {
  const state = fixture(context);
  createAssets(state);
  const android = state.read("android-manifest.json");
  android.assets[1].applicationId = "app.alextran.immich";
  state.write("android-manifest.json", JSON.stringify(android));
  requireFailure(state.run("manifest"), /app\.alextran\.immich/);
  assert(!existsSync(path.join(state.output, "release-manifest.json")));
  assert.deepEqual(state.calls(), []);
});

test("manifest rejects a container platform built from another revision", (context) => {
  const state = fixture(context, {
    imageRevisions: { [`${mlImage}/arm64`]: otherSha },
  });
  createAssets(state);
  requireFailure(state.run("manifest"), /Wrong source commit/);
  assert(!existsSync(path.join(state.output, "release-manifest.json")));
});

test("publish verifies uploaded assets before making a draft public", (context) => {
  const state = fixture(context);
  createAssets(state);
  requireSuccess(state.run("manifest"));
  state.clearCalls();
  requireSuccess(state.run("publish"));
  assert.deepEqual(
    releaseMutations(state.calls()).map(({ args }) => args[1]),
    ["create", "upload", "edit"],
  );
  assert.equal(
    state.calls().filter(({ args }) => args[1]?.includes("/git/ref/tags/"))
      .length,
    2,
  );
});

test("publish resumes an existing draft without creating a second release", (context) => {
  const state = fixture(context, {
    release: {
      draft: true,
      target_commitish: sha,
      assets: [{ name: "immich-audio-arm64-v8a.apk" }],
    },
  });
  createAssets(state);
  requireSuccess(state.run("manifest"));
  state.clearCalls();
  requireSuccess(state.run("publish"));
  assert.deepEqual(
    releaseMutations(state.calls()).map(({ args }) => args[1]),
    ["upload", "edit"],
  );
});

test("publish refuses an existing draft with unexpected attachments", (context) => {
  const state = fixture(context, {
    release: {
      draft: true,
      target_commitish: sha,
      assets: [{ name: "unexpected-secret.txt" }],
    },
  });
  createAssets(state);
  requireSuccess(state.run("manifest"));
  state.clearCalls();
  requireFailure(state.run("publish"), /Draft contains unexpected assets/);
  assert.deepEqual(releaseMutations(state.calls()), []);
});

test("publish refuses a tag that moved before uploading attachments", (context) => {
  const state = fixture(context, { remoteTags: [otherSha] });
  createAssets(state);
  requireSuccess(state.run("manifest"));
  state.clearCalls();
  requireFailure(state.run("publish"), /Remote release tag changed/);
  assert.deepEqual(releaseMutations(state.calls()), []);
});

test("publish leaves the draft private if the tag moves during upload", (context) => {
  const state = fixture(context, { remoteTags: [sha, otherSha] });
  createAssets(state);
  requireSuccess(state.run("manifest"));
  state.clearCalls();
  requireFailure(state.run("publish"), /Remote release tag changed/);
  assert.deepEqual(
    releaseMutations(state.calls()).map(({ args }) => args[1]),
    ["create", "upload"],
  );
});
