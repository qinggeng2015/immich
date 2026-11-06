import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const output = path.resolve(".scratch/fork-release");
const command = (file, args, options = {}) => {
  const result = execFileSync(file, args, { encoding: "utf8", ...options });
  return typeof result === "string" ? result.trim() : "";
};
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (name, value) =>
  writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
const repository =
  process.env.RELEASE_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
const sha = process.env.RELEASE_SHA ?? process.env.GITHUB_SHA;
assert.match(tag ?? "", /^audio-[a-z0-9][a-z0-9_.-]{0,121}$/);
assert.equal(repository, "qinggeng2015/immich");
assert.match(sha ?? "", /^[0-9a-f]{40}$/);
const owner = repository.split("/")[0].toLowerCase();
const serverImage = `ghcr.io/${owner}/immich-server:${tag}`;
const mlImage = `ghcr.io/${owner}/immich-machine-learning:${tag}`;
const certificate =
  "eb356e414b2f8e38b238b89b8a2ebb0b5d7ff56939f30e6b794408d9758284ed";
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const getRelease = () => {
  const releases = JSON.parse(
    command("gh", [
      "api",
      `repos/${repository}/releases?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  ).flat();
  const matches = releases.filter((release) => release.tag_name === tag);
  assert(matches.length <= 1, "Multiple releases use this tag");
  return matches[0];
};

const verifyRemoteTag = () => {
  let object = JSON.parse(
    command("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`]),
  ).object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
    object = JSON.parse(
      command("gh", ["api", `repos/${repository}/git/tags/${object.sha}`]),
    ).object;
  }
  assert.equal(object.type, "commit");
  assert.equal(
    object.sha,
    sha,
    "Remote release tag changed after this workflow started",
  );
};

const verifyDraft = (release) => {
  assert(
    !release || release.draft,
    "This tag already has a published release; choose a new tag",
  );
  if (release)
    assert.equal(
      release.target_commitish,
      sha,
      "Draft release targets another commit",
    );
};

const replaceRequired = (text, before, after) => {
  assert(text.includes(before), `Expected release template value: ${before}`);
  return text.replaceAll(before, after);
};

const prepare = () => {
  assert.equal(
    process.env.GITHUB_REF,
    `refs/tags/${tag}`,
    "Run the release workflow from an audio-* tag",
  );
  assert.equal(command("git", ["rev-list", "-n", "1", tag]), sha);
  verifyRemoteTag();
  verifyDraft(getRelease());
  const buildNumber =
    process.env.RELEASE_BUILD_NUMBER ||
    String(3_040_000 + Number(process.env.GITHUB_RUN_NUMBER));
  assert.match(buildNumber, /^[1-9][0-9]{6,9}$/);
  assert(
    Number(buildNumber) >= 3_040_001 && Number(buildNumber) <= 2_000_000_000,
  );
  let previousCheck;
  try {
    const runs = JSON.parse(
      command("gh", [
        "api",
        `repos/${repository}/actions/workflows/fork-ci.yml/runs?head_sha=${sha}&status=success&per_page=20`,
      ]),
    );
    previousCheck = runs.workflow_runs.find(
      (run) =>
        run.head_sha === sha &&
        run.conclusion === "success" &&
        ["push", "workflow_dispatch"].includes(run.event),
    );
  } catch {
    previousCheck = undefined;
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tag=${tag}\nbuild-number=${buildNumber}\nneeds-checks=${!previousCheck}\n`,
  );
  console.log(
    previousCheck
      ? `Reusing successful checks for ${sha}: ${previousCheck.html_url}`
      : `Checks required for ${sha}`,
  );
};

const packages = () => {
  mkdirSync(output, { recursive: true });
  for (const name of ["sdk", "cli"]) {
    command(
      "pnpm",
      ["--dir", `packages/${name}`, "pack", "--pack-destination", output],
      { stdio: "inherit" },
    );
  }
  for (const filename of [
    "docker-compose.yml",
    "docker-compose.rootless.yml",
  ]) {
    let compose = readFileSync(`docker/${filename}`, "utf8");
    compose = replaceRequired(
      compose,
      "https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml",
      `https://github.com/${repository}/releases/download/${tag}/${filename}`,
    );
    compose = replaceRequired(
      compose,
      "name: immich\n",
      "name: immich-audio\n",
    );
    compose = replaceRequired(
      compose,
      "container_name: immich_",
      "container_name: immich_audio_",
    );
    compose = replaceRequired(
      compose,
      "ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-release}",
      `ghcr.io/${owner}/immich-server:` + "${IMMICH_VERSION:-" + tag + "}",
    );
    compose = replaceRequired(
      compose,
      "ghcr.io/immich-app/immich-machine-learning:${IMMICH_VERSION:-release}",
      `ghcr.io/${owner}/immich-machine-learning:` +
        "${IMMICH_VERSION:-" +
        tag +
        "}",
    );
    compose = replaceRequired(compose, "'2283:2283'", "'2285:2283'");
    compose = compose
      .split("\n")
      .filter(
        (line) =>
          !line.includes("For hardware acceleration") &&
          !line.includes("Example tag:") &&
          !line.includes("hwaccel.ml.yml") &&
          !line.includes("accelerated inference") &&
          !line.includes("uncomment this section for hardware acceleration"),
      )
      .join("\n");
    writeFileSync(path.join(output, filename), compose);
  }
  let environment = readFileSync("docker/example.env", "utf8");
  environment = replaceRequired(
    environment,
    "IMMICH_VERSION=v3",
    `IMMICH_VERSION=${tag}`,
  );
  environment = replaceRequired(
    environment,
    "UPLOAD_LOCATION=./library",
    "UPLOAD_LOCATION=./audio-library",
  );
  environment = replaceRequired(
    environment,
    "DB_DATA_LOCATION=./postgres",
    "DB_DATA_LOCATION=./audio-postgres",
  );
  writeFileSync(path.join(output, "example.env"), environment);
  for (const filename of ["hwaccel.transcoding.yml", "prometheus.yml"]) {
    copyFileSync(`docker/${filename}`, path.join(output, filename));
  }
  copyFileSync(
    "open-api/immich-openapi-specs.json",
    path.join(output, "immich-openapi-specs.json"),
  );
  writeFileSync(
    path.join(output, "INSTALL-zh.md"),
    `# Immich Audio ${tag}\n\n源码提交：${sha}\n\n## Android\n\n选择手机对应的 APK。大多数现代手机使用 arm64-v8a。独立包名为 app.alextran.immich.audio，可与原版共存，沿用此前测试 APK 的签名。Android 只执行静态分析与构建，运行测试由用户完成。\n\n## 服务端\n\n下载 docker-compose.yml、example.env 和 hwaccel.transcoding.yml 到独立目录，将 example.env 复制为 .env，设置数据库密码和数据目录，然后运行 docker compose up -d。默认访问端口为 2285。已存在的数据目录应先备份；音频摘要默认关闭，在机器学习设置中填写模型接口和密钥后开启。\n\nServer 镜像：${serverImage}\n\nCPU ML 镜像：${mlImage}\n\n两种镜像均支持 linux/amd64 和 linux/arm64。该发布仅提供 CPU ML 镜像。\n\n## SDK 与 CLI\n\n随附的 SDK 和 CLI tgz 是本分支构建产物，可通过 npm install ./文件名.tgz 安装；没有发布到上游 npm 命名空间。全部附件校验值见 SHA256SUMS，源码与镜像摘要见 release-manifest.json。\n`,
  );
};

const manifest = () => {
  const android = json(path.join(output, "android-manifest.json"));
  assert.equal(android.commit, sha);
  assert.equal(android.applicationId, "app.alextran.immich.audio");
  assert.equal(android.certificateSha256, certificate);
  assert.equal(android.assets.length, 3);
  const offsets = { "armeabi-v7a": 1000, "arm64-v8a": 2000, x86_64: 4000 };
  for (const [abi, offset] of Object.entries(offsets)) {
    const asset = android.assets.find((item) => item.abi === abi);
    assert(asset, `Missing APK metadata for ${abi}`);
    assert.equal(asset.file, `immich-audio-${abi}.apk`);
    assert.equal(asset.applicationId, android.applicationId);
    assert.equal(asset.certificateSha256, certificate);
    assert.equal(
      asset.versionCode,
      Number(process.env.RELEASE_BUILD_NUMBER) + offset,
    );
    const content = readFileSync(path.join(output, asset.file));
    assert.equal(asset.bytes, content.length);
    assert.equal(asset.sha256, hash(path.join(output, asset.file)));
  }
  const expected = [
    "immich-audio-armeabi-v7a.apk",
    "immich-audio-arm64-v8a.apk",
    "immich-audio-x86_64.apk",
    "docker-compose.yml",
    "docker-compose.rootless.yml",
    "example.env",
    "INSTALL-zh.md",
    "immich-openapi-specs.json",
  ];
  const files = readdirSync(output)
    .filter((name) => !["SHA256SUMS", "release-manifest.json"].includes(name))
    .sort();
  for (const filename of expected)
    assert(files.includes(filename), `Missing release asset ${filename}`);
  assert(
    files.some((name) => /^immich-sdk-.*\.tgz$/.test(name)),
    "Missing SDK package",
  );
  assert(
    files.some((name) => /^immich-cli-.*\.tgz$/.test(name)),
    "Missing CLI package",
  );
  assert.equal(process.env.RELEASE_SERVER_IMAGE, serverImage);
  assert.equal(process.env.RELEASE_ML_IMAGE, mlImage);
  const images = {};
  for (const image of [serverImage, mlImage]) {
    const raw = command("docker", [
      "buildx",
      "imagetools",
      "inspect",
      "--raw",
      image,
    ]);
    const index = JSON.parse(raw);
    const configs = JSON.parse(
      command("docker", [
        "buildx",
        "imagetools",
        "inspect",
        "--format",
        "{{json .Image}}",
        image,
      ]),
    );
    for (const architecture of ["amd64", "arm64"]) {
      assert(
        index.manifests.some(
          (entry) =>
            entry.platform.os === "linux" &&
            entry.platform.architecture === architecture,
        ),
        `${image} lacks linux/${architecture}`,
      );
      const labels = configs[`linux/${architecture}`]?.config?.Labels;
      assert.equal(
        labels?.["org.opencontainers.image.revision"],
        sha,
        `Wrong source commit in ${image}/${architecture}`,
      );
      assert.equal(
        labels?.["org.opencontainers.image.source"],
        `https://github.com/${repository}`,
      );
    }
    const details = command("docker", [
      "buildx",
      "imagetools",
      "inspect",
      image,
    ]);
    const digest = details.match(/^Digest:\s+(sha256:[0-9a-f]{64})$/m)?.[1];
    assert(digest, `No manifest digest for ${image}`);
    images[image] = digest;
  }
  const assets = files.map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(readFileSync(path.join(output, name)))
      .digest("hex"),
  }));
  writeJson("release-manifest.json", {
    tag,
    repository,
    sha,
    images,
    android,
    assets,
  });
  assets.push({
    name: "release-manifest.json",
    sha256: createHash("sha256")
      .update(readFileSync(path.join(output, "release-manifest.json")))
      .digest("hex"),
  });
  writeFileSync(
    path.join(output, "SHA256SUMS"),
    assets.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(""),
  );
};

const publish = () => {
  const releaseManifest = json(path.join(output, "release-manifest.json"));
  assert.equal(releaseManifest.sha, sha);
  assert.equal(releaseManifest.tag, tag);
  for (const asset of releaseManifest.assets)
    assert.equal(hash(path.join(output, asset.name)), asset.sha256);
  verifyRemoteTag();
  const existing = getRelease();
  verifyDraft(existing);
  const filenames = readdirSync(output).sort();
  if (existing)
    assert(
      existing.assets.every((asset) => filenames.includes(asset.name)),
      "Draft contains unexpected assets; review them before retrying",
    );
  if (!existing) {
    command(
      "gh",
      [
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--verify-tag",
        "--target",
        sha,
        "--draft",
        "--prerelease",
        "--title",
        `Immich Audio ${tag}`,
        "--notes-file",
        path.join(output, "INSTALL-zh.md"),
      ],
      { stdio: "inherit" },
    );
  }
  command(
    "gh",
    [
      "release",
      "upload",
      tag,
      "--repo",
      repository,
      "--clobber",
      ...readdirSync(output)
        .sort()
        .map((name) => path.join(output, name)),
    ],
    { stdio: "inherit" },
  );
  const uploaded = getRelease();
  verifyDraft(uploaded);
  assert.deepEqual(
    uploaded.assets.map((asset) => asset.name).sort(),
    filenames,
  );
  for (const asset of uploaded.assets) {
    assert.equal(asset.state, "uploaded");
    assert.equal(
      asset.size,
      readFileSync(path.join(output, asset.name)).length,
    );
    assert.equal(asset.digest, `sha256:${hash(path.join(output, asset.name))}`);
  }
  verifyRemoteTag();
  command(
    "gh",
    [
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--draft=false",
      "--prerelease",
      "--latest=false",
    ],
    { stdio: "inherit" },
  );
};

const operation = { prepare, packages, manifest, publish }[process.argv[2]];
assert(operation, "Expected prepare, packages, manifest or publish");
operation();
