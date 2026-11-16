/**
 * GitHub 推送脚本（直连 push 被墙，走 Git Data API 重放提交）
 * 用法：$env:GH_TOKEN = gh auth token; node api-push.js [repoDir]
 * 坑 #11：git diff-tree 必须 -z（NUL 分隔不转义非 ASCII 路径），二进制读出再按 UTF-8 解析
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'Dhuaing/bome-live';
const repoDir = process.argv[2] || 'D:\\小程序';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺 GH_TOKEN'); process.exit(1); }

const api = async (url, opts = {}) => {
  const res = await fetch(`https://api.github.com${url}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API ${res.status} ${url}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024, ...opts });
const gitBuf = (args) => spawnSync('git', args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 }).stdout;

function parseDiffZ(metaAndPaths) {
  // diff-tree -z 输出: ":om nm os ns STATUS\0path\0[:om nm os ns STATUS\0path\0(old)\0]..."
  const out = [];
  let i = 0;
  const toks = metaAndPaths;
  while (i < toks.length) {
    const t = toks[i];
    if (t.startsWith(':')) {
      const parts = t.slice(1).split(' ');
      const status = parts[4];
      if (status === 'D') {
        out.push({ status: 'D', path: toks[i + 1] });
        i += 2;
      } else {
        out.push({ status, path: toks[i + 1], mode: parts[1], blob: parts[3] });
        i += status.startsWith('R') || status.startsWith('C') ? 3 : 2;
      }
    } else {
      i += 1;
    }
  }
  return out;
}

(async () => {
  // 1. 远端头
  const remoteHead = await api('/repos/' + REPO + '/git/ref/heads/master');
  const remoteCommitSha = remoteHead.object.sha;
  const remoteCommit = await api('/repos/' + REPO + '/git/commits/' + remoteCommitSha);
  const remoteTree = remoteCommit.tree.sha;
  console.log('远端头:', remoteCommitSha.slice(0, 8), 'tree:', remoteTree.slice(0, 8));

  // 2. 本地提交链（新→旧）。远端头 tree 可能被坏重放污染，所以取远端
  // 近若干提交的 tree 集合，找「最新一个 tree 已存在于远端」的本地提交作锚点。
  const remoteCommits = await api('/repos/' + REPO + '/commits?per_page=30');
  const remoteTreeSet = new Set(remoteCommits.map((c) => c.commit.tree.sha));
  const logRaw = git(['log', '--format=%H %T', 'HEAD']).toString().trim().split('\n');
  const chain = logRaw.map((l) => ({ sha: l.split(' ')[0], tree: l.split(' ')[1] }));
  let anchorIdx = chain.findIndex((c) => remoteTreeSet.has(c.tree));
  if (anchorIdx < 0) { console.error('本地链上找不到任何 tree 已在远端的锚点，中止'); process.exit(1); }
  const toPush = chain.slice(0, anchorIdx).reverse(); // 旧→新
  console.log('待重放提交数:', toPush.length, toPush.map((c) => c.sha.slice(0, 7)).join(','));

  let prevCommitSha = remoteCommitSha;
  let prevTree = remoteTree;

  for (const c of toPush) {
    const parents = git(['log', '-1', '--format=%P', c.sha]).toString().trim().split(' ').filter(Boolean);
    // 本地父提交是否就是上一个已重放提交（线性）；否则按本地父对 diff
    const parentSha = parents[0];
    const diffToks = gitBuf(['diff-tree', '-r', '-z', parentSha, c.sha])
      .toString('utf8').split('\0').filter((s) => s !== '');
    const changes = parseDiffZ(diffToks);

    const treeEntries = [];
    for (const ch of changes) {
      // Tree API 的 base_tree 是叠加语义：省略条目≠删除。
      // 删除必须显式给 sha:null 条目（GitHub 文档语义）。
      if (ch.status === 'D') {
        treeEntries.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const content = gitBuf(['cat-file', 'blob', ch.blob]); // 二进制安全取内容
      const blob = await api('/repos/' + REPO + '/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
      });
      treeEntries.push({ path: ch.path, mode: ch.mode, type: 'blob', sha: blob.sha });
    }
    const tree = await api('/repos/' + REPO + '/git/trees', {
      method: 'POST',
      body: JSON.stringify({ base_tree: prevTree, tree: treeEntries }),
    });

    const msg = git(['log', '-1', '--format=%B', c.sha]).toString();
    const an = git(['log', '-1', '--format=%an', c.sha]).toString().trim();
    const ae = git(['log', '-1', '--format=%ae', c.sha]).toString().trim();
    const ad = git(['log', '-1', '--format=%ai', c.sha]).toString().trim();
    const [d, t, off] = ad.split(' ');
    const iso = `${d}T${t}${off.slice(0, 3)}:${off.slice(3)}`;
    const commit = await api('/repos/' + REPO + '/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: msg, tree: tree.sha, parents: [prevCommitSha],
        author: { name: an, email: ae, date: iso },
        committer: { name: an, email: ae, date: iso },
      }),
    });
    prevCommitSha = commit.sha;
    prevTree = tree.sha;
    // 终检：重放后的 tree 必须与本地提交 tree 一致（内容等价），否则中止
    if (tree.sha !== c.tree) {
      console.error(`tree 不一致! 本地 ${c.tree.slice(0, 8)} vs 远端重放 ${tree.sha.slice(0, 8)} @ ${c.sha.slice(0, 7)}`);
      process.exit(1);
    }
    console.log('已重放', c.sha.slice(0, 7), '→', commit.sha.slice(0, 8), 'tree 校验一致', msg.split('\n')[0].slice(0, 40));
  }

  // 3. 更新 ref（远端头可能已被坏重放污染，允许 force 由锚点之前的树保证安全）
  if (toPush.length) {
    await api('/repos/' + REPO + '/git/refs/heads/master', {
      method: 'PATCH',
      body: JSON.stringify({ sha: prevCommitSha, force: true }),
    });
    console.log('ref 已更新到', prevCommitSha.slice(0, 8));
  }

  // 4. 坑 #11 终检：远端树不应有带引号/反斜杠的坏路径
  const head = await api('/repos/' + REPO + '/commits/master');
  const treeFull = await api('/repos/' + REPO + '/git/trees/' + head.sha + '?recursive=1');
  const bad = treeFull.tree.filter((e) => /["\\]/.test(e.path));
  console.log('终检: 远端条目', treeFull.tree.length, '坏路径', bad.length);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('推送失败:', e.message); process.exit(1); });
