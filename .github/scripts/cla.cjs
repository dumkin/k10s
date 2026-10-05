// The CLA check of a pull request (run by .github/workflows/cla.yml through actions/github-script).
//
// Every author of the pull request's commits must have signed CLA.md, once, by commenting the sentence below on a
// pull request. Signatures are kept in signatures/cla.json on the `cla-signatures` branch of this repository: a
// branch of its own (made here on the first signature), so that nobody needs to write to the main branch.
// The result is the commit status "CLA" (make it required in the branch rules) and one comment that is kept up
// to date.

const BRANCH = "cla-signatures";
const FILE = "signatures/cla.json";
const PHRASE = "I have read the CLA Document and I hereby sign the CLA";
const MARKER = "<!-- k10s-cla -->";

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const number = context.payload.pull_request?.number ?? (context.payload.issue?.pull_request ? context.payload.issue.number : null);
  if (!number) return;
  const allowlist = new Set((process.env.CLA_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const document = `https://github.com/${owner}/${repo}/blob/${context.payload.repository.default_branch}/CLA.md`;

  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pull.state !== "open") return;
  const commits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: number, per_page: 100 });

  // Who wrote the commits. An author whose email belongs to no GitHub account can't sign: they must add it first.
  const authors = new Map();
  const unknown = new Set();
  for (const c of commits) {
    if (c.author?.login) authors.set(c.author.login.toLowerCase(), { login: c.author.login, id: c.author.id });
    else unknown.add(`${c.commit.author?.name ?? "someone"} <${c.commit.author?.email ?? "no email"}>`);
  }
  const needed = [...authors.values()].filter((a) => !a.login.endsWith("[bot]") && !allowlist.has(a.login.toLowerCase()));

  let { signatures, sha } = await load(github, owner, repo);
  const signed = () => new Set(signatures.map((s) => s.login.toLowerCase()));

  // Signing: the sentence, commented by an author of this pull request who hasn't signed yet.
  const comment = context.eventName === "issue_comment" ? context.payload.comment : null;
  if (comment && comment.body.trim() === PHRASE) {
    const who = needed.find((a) => a.login.toLowerCase() === comment.user.login.toLowerCase());
    if (who && !signed().has(who.login.toLowerCase())) {
      for (let attempt = 0; ; attempt++) {
        const next = [...signatures, { login: who.login, id: who.id, signedAt: comment.created_at, pullRequest: number, comment: comment.html_url }];
        try {
          await save(github, owner, repo, next, sha, `CLA signed by @${who.login} in #${number}`);
          signatures = next;
          break;
        } catch (e) {
          // Someone else signed at the same moment: read again and retry.
          if (attempt >= 2 || ![409, 422].includes(e.status)) throw e;
          ({ signatures, sha } = await load(github, owner, repo));
          if (signed().has(who.login.toLowerCase())) break;
        }
      }
      core.info(`${who.login} signed the CLA.`);
    }
  }

  const missing = needed.filter((a) => !signed().has(a.login.toLowerCase()));
  const ok = missing.length === 0 && unknown.size === 0;
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: pull.head.sha,
    state: ok ? "success" : "failure",
    context: "CLA",
    description: ok ? "Every author has signed the CLA" : missing.length ? `Waiting for ${missing.map((a) => `@${a.login}`).join(", ")} to sign the CLA` : "Some commits belong to no GitHub account",
    target_url: document,
  });

  const lines = ok
    ? ["Every author of this pull request has signed the CLA. Thank you!"]
    : [
        "Thanks for the pull request! Before it can be merged, every author of its commits needs to sign the",
        `[Contributor License Agreement](${document}): read it, then reply here with this exact comment.`,
        "",
        "```",
        PHRASE,
        "```",
        "",
        "It's a one-time step: it covers all your future contributions to this project.",
        ...(missing.length ? ["", `Not signed yet: ${missing.map((a) => `@${a.login}`).join(", ")}.`] : []),
        ...(unknown.size
          ? ["", `These commit authors aren't linked to a GitHub account, so they can't sign: ${[...unknown].join(", ")}. Add that email to your GitHub account (or amend the commits) and comment \`recheck\`.`]
          : []),
      ];
  const body = `${MARKER}\n${lines.join("\n")}`;
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
  const mine = comments.find((c) => c.user?.type === "Bot" && c.body?.startsWith(MARKER));
  if (mine) {
    if (mine.body !== body) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  } else if (!ok) {
    await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  }
  if (!ok) core.setFailed(`The CLA is not signed by every author yet.`);
};

async function load(github, owner, repo) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: FILE, ref: BRANCH });
    return { signatures: JSON.parse(Buffer.from(data.content, "base64").toString("utf8")), sha: data.sha };
  } catch (e) {
    // No branch or no file yet: nobody has signed.
    if (e.status === 404) return { signatures: [], sha: undefined };
    throw e;
  }
}

async function save(github, owner, repo, signatures, sha, message) {
  const content = `${JSON.stringify(signatures, null, 2)}\n`;
  try {
    await github.rest.repos.createOrUpdateFileContents({ owner, repo, path: FILE, branch: BRANCH, message, content: Buffer.from(content).toString("base64"), sha });
  } catch (e) {
    if (e.status !== 404 && e.status !== 422) throw e;
    // The branch doesn't exist yet: make it, with nothing but the signatures in it.
    const { data: ref } = await github.rest.git.getRef({ owner, repo, ref: `heads/${BRANCH}` }).catch(() => ({ data: null }));
    if (ref) throw e;
    const { data: blob } = await github.rest.git.createBlob({ owner, repo, content, encoding: "utf-8" });
    const { data: tree } = await github.rest.git.createTree({ owner, repo, tree: [{ path: FILE, mode: "100644", type: "blob", sha: blob.sha }] });
    const { data: commit } = await github.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents: [] });
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
}
