#!/usr/bin/env node
// Checks and fixes the update feed (latest.json) of a draft release once every build has uploaded its part:
// - every platform the release workflow builds is there (parallel builds rewrite the file in turn, and one can
//   lose another's entry);
// - downloads point at github.com/…/releases/download/…, not at the API, which allows 60 requests an hour per
//   address without a token: a whole office behind one address would run out on release day.
//
// Needs GITHUB_REPOSITORY, GH_TOKEN, RELEASE (the release id) and TAG.

const { GITHUB_REPOSITORY: repo, GH_TOKEN: token, RELEASE: release, TAG: tag } = process.env;
if (!repo || !token || !release || !tag) {
  console.error("GITHUB_REPOSITORY, GH_TOKEN, RELEASE and TAG must be set.");
  process.exit(2);
}

/** What the release workflow builds (keys of latest.json). */
const PLATFORMS = ["darwin-aarch64", "windows-x86_64", "linux-x86_64", "linux-aarch64"];

const api = async (path, init = {}) => {
  const res = await fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", accept: "application/vnd.github+json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res;
};

const assets = await (await api(`/repos/${repo}/releases/${release}/assets?per_page=100`)).json();
const feed = assets.find((a) => a.name === "latest.json");
if (!feed) {
  console.error("The release has no latest.json: did the builds run with createUpdaterArtifacts?");
  process.exit(1);
}
const latest = await (await api(feed.url, { headers: { accept: "application/octet-stream" } })).json();

const missing = PLATFORMS.filter((p) => !latest.platforms?.[p]);
if (missing.length) {
  console.error(`latest.json has no entry for ${missing.join(", ")}. Re-run the failed builds, then this job.`);
  process.exit(1);
}

const byId = new Map(assets.map((a) => [String(a.id), a]));
let changed = false;
for (const [platform, entry] of Object.entries(latest.platforms)) {
  if (!entry.signature) {
    console.error(`${platform}: no signature.`);
    process.exit(1);
  }
  const id = entry.url.match(/\/releases\/assets\/(\d+)$/)?.[1];
  const asset = id ? byId.get(id) : assets.find((a) => entry.url.endsWith(`/${encodeURIComponent(a.name)}`));
  if (!asset) {
    console.error(`${platform}: ${entry.url} is not a file of this release.`);
    process.exit(1);
  }
  const direct = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
  if (entry.url !== direct) {
    entry.url = direct;
    changed = true;
  }
  console.log(`${platform}: ${asset.name}`);
}

if (changed) {
  await api(`/repos/${repo}/releases/assets/${feed.id}`, { method: "DELETE" });
  await api(`https://uploads.github.com/repos/${repo}/releases/${release}/assets?name=latest.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `${JSON.stringify(latest, null, 2)}\n`,
  });
  console.log("latest.json now links the files directly.");
} else {
  console.log("latest.json is complete.");
}
