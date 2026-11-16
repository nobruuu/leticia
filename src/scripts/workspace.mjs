import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const state = '/work/.reproducible';
const action = process.argv[2];
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} failed; no artifact will be activated`);
}
function versions() {
  assert.equal(process.version, 'v24.22.3', 'This procedure requires Node 24.22.3');
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  assert.equal(npm.status, 0, 'Cannot identify npm');
  assert.equal(npm.stdout.trim(), '11.19.1', 'This procedure requires image-bundled npm 11.19.1');
  return { node: process.version, npm: npm.stdout.trim(), platform: process.platform, arch: process.arch };
}
function tree(directory, excluded = []) {
  const files = {};
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (excluded.includes(relative)) continue;
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isSymbolicLink()) files[relative] = `link:${fs.readlinkSync(file)}`;
      else if (stat.isFile()) files[relative] = sha(fs.readFileSync(file));
      else throw new Error('Unsupported filesystem entry: ' + relative);
    }
  }
  visit(directory);
  return { files, sha256: sha(JSON.stringify(files)) };
}
function sources(directory, info) {
  for (const [name, hash] of Object.entries(info.files)) {
    assert.equal(sha(fs.readFileSync(path.join(directory, name))), hash, `Source changed: ${name}`);
  }
}
function verify(directory) {
  const info = read(path.join(directory, 'build/BUILD_INFO.json'));
  assert.deepEqual(versions(), info.versions, 'Build/runtime versions differ');
  sources(directory, info.source);
  assert.equal(tree(path.join(directory, 'build'), ['assets', 'BUILD_INFO.json']).sha256, info.buildSha256, 'Build changed');
  assert.equal(tree(path.join(directory, 'node_modules')).sha256, info.dependenciesSha256, 'Installed dependencies changed');
  assert.equal(sha(fs.readFileSync(path.join(directory, 'build/index.js'))), info.entrypointSha256, 'Entrypoint changed');
  console.log(JSON.stringify({ buildId: info.source.buildId, revision: info.source.revision,
    dirty: info.source.dirty, sourceSha256: info.source.sourceSha256, lockSha256: info.source.lockSha256,
    versions: info.versions, buildSha256: info.buildSha256, entrypointSha256: info.entrypointSha256,
    artifact: '/work/build/index.js' }, null, 2));
  return info;
}
function build() {
  const currentVersions = versions(), source = read(path.join(root, '.source-info.json'));
  assert(!fs.existsSync('node_modules') && !fs.existsSync('build'), 'Candidate workspace must be fresh');
  sources(root, source);
  for (const [key, value] of Object.entries(source.buildEnvironment)) assert.equal(process.env[key], value, 'Build env mismatch');
  command('npm', ['ci', '--include=dev', '--no-audit', '--no-fund']);
  sources(root, source); // npm ci must not rewrite package.json or the lockfile.
  command('npm', ['run', 'build']);
  sources(root, source);
  const info = {
    createdAt: new Date().toISOString(), source, versions: currentVersions,
    install: 'npm ci --include=dev --no-audit --no-fund',
    dependenciesSha256: tree('node_modules').sha256,
    buildSha256: tree('build', ['assets', 'BUILD_INFO.json']).sha256,
    entrypointSha256: sha(fs.readFileSync('build/index.js')),
    artifact: '/work/build/index.js'
  };
  write('build/BUILD_INFO.json', info);
  verify(root);
}
function activate() {
  assert(root.startsWith(state + '/releases/'), 'Activation requires a prepared release directory');
  const info = verify(root), id = info.source.buildId;
  const old = path.join(state, 'backups', id), corpus = path.join(state, 'corpus', id);
  assert(!fs.existsSync(old) && !fs.existsSync(corpus), 'This release has already been activated; use start without an ID');
  const assets = '/work/build/assets';
  assert(fs.existsSync(path.join(assets, 'documents')), 'Existing corpus not found; refusing activation');
  const original = tree(assets);
  assert(Object.keys(original.files).some(name => name.startsWith('documents/')), 'Existing corpus is empty');
  fs.mkdirSync(corpus, { recursive: true });
  command('cp', ['-a', assets, path.join(corpus, 'assets')]);
  assert.equal(tree(path.join(corpus, 'assets')).sha256, original.sha256, 'Corpus backup verification failed');
  write(path.join(corpus, 'manifest.json'), original);
  console.log(`Verified persistent corpus backup: ${corpus}; files=${Object.keys(original.files).length}`);
  fs.mkdirSync(old, { recursive: true });
  const moved = [];
  let publishing = false;
  try {
    for (const name of fs.readdirSync('/work')) {
      if (name === '.reproducible') continue;
      fs.renameSync(path.join('/work', name), path.join(old, name));
      moved.push(name);
    }
    publishing = true;
    command('cp', ['-a', root + '/.', '/work/']);
    command('cp', ['-a', path.join(corpus, 'assets') + '/.', '/work/build/assets/']);
    assert.equal(tree('/work/build/assets').sha256, original.sha256, 'Restored corpus differs');
    verify('/work');
    write(path.join(state, 'active.json'), { buildId: id, activatedAt: new Date().toISOString(),
      backup: old, corpusBackup: corpus, artifact: '/work/build/index.js' });
  } catch (error) {
    try {
      // Keep failed files for inspection, rather than deleting either workspace.
      const failed = path.join(state, 'failed', id);
      fs.mkdirSync(failed, { recursive: true });
      for (const name of fs.readdirSync('/work')) {
        if (name === '.reproducible' || !publishing) continue;
        fs.renameSync(path.join('/work', name), path.join(failed, name));
      }
      for (const name of moved) fs.renameSync(path.join(old, name), path.join('/work', name));
    } catch (restoreError) {
      console.error('Automatic restore failed; keep webapp stopped. Backup:', old);
      error.restoreFailed = true;
    }
    throw error;
  }
}
try {
  assert(process.argv.length === 3, 'Expected build, activate or verify');
  if (action === 'build') build();
  else if (action === 'activate') activate();
  else if (action === 'verify') verify(root);
  else throw new Error('Unknown action');
} catch (error) {
  console.error(error.message);
  process.exitCode = error.restoreFailed ? 2 : 1;
}
