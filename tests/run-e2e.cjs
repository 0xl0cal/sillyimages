const { spawnSync, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync, readdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const engine = process.argv[2] || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw new Error('Choose chromium or webkit');
const artifacts = path.join(__dirname, 'artifacts', 'suite-' + engine);
mkdirSync(artifacts, {recursive: true});
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim(), engine, passed:false, suites:[]};
report.worktree = execFileSync('git', ['status', '--porcelain'], {cwd:root, encoding:'utf8'}).trim();
report.sources = Object.fromEntries(['index.js','manifest.json','style.css',...readdirSync(path.join(root,'src')).filter(name=>name.endsWith('.js')).map(name=>'src/'+name)]
    .sort().map(file=>[file,createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex')]));
const scripts = ['a1111', 'provider-references', 'reference-transfer', 'avatar-picker', 'chat-image-actions', 'lightbox', 'generation-library', 'ui-lifecycle', 'generation-ownership'];
if (engine === 'chromium') scripts.push('novelai', 'naistera-parameters');
for (const name of scripts) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(__dirname, name + '-e2e.cjs')], {
        cwd:root, env:{...process.env, IIG_BROWSER_ENGINE:engine}, encoding:'utf8', timeout:240000,
    });
    const log = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
    writeFileSync(path.join(artifacts, name + '.log'), log);
    const directory = name === 'lightbox' ? (engine === 'webkit' ? 'lightbox-webkit' : 'lightbox')
        : ['novelai','naistera-parameters'].includes(name) ? name : name + '-' + engine;
    const file = path.join(__dirname, 'artifacts', directory, 'report.json');
    let details;
    try { details = JSON.parse(readFileSync(file, 'utf8')); } catch { details = null; }
    report.suites.push({name,passed:result.status===0,durationMs:Date.now()-started,checks:details?.checks?.length,report:path.relative(root,file)});
    console.log(`${result.status===0?'PASS':'FAIL'} ${name} (${engine})`);
    if (result.status !== 0) { console.error(log); break; }
}
report.passed = report.suites.length === scripts.length && report.suites.every(suite=>suite.passed);
writeFileSync(path.join(artifacts,'report.json'), JSON.stringify(report,null,2));
console.log(path.join(artifacts,'report.json'));
process.exitCode = report.passed ? 0 : 1;
