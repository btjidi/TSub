import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const pairs = [
  ['README.md', 'README_EN.md'],
  ['docs/USER_GUIDE.md', 'docs/USER_GUIDE_EN.md'],
  ['docs/PROXY_DEPLOYMENT.md', 'docs/PROXY_DEPLOYMENT_EN.md'],
  ['docs/ARCHITECTURE.md', 'docs/ARCHITECTURE_EN.md'],
  ['docs/API_REFERENCE.md', 'docs/API_REFERENCE_EN.md'],
  ['docs/DATA_MODEL.md', 'docs/DATA_MODEL_EN.md'],
  ['docs/SECURITY.md', 'docs/SECURITY_EN.md'],
  ['docs/OPERATIONS.md', 'docs/OPERATIONS_EN.md'],
  ['docs/DEVELOPMENT.md', 'docs/DEVELOPMENT_EN.md']
];
const standalone = ['docs/SERVER_DEPLOYMENT_EN.md'];
const expected = new Set([...pairs.flat(), ...standalone].map(item => item.replaceAll('\\', '/')));
const errors = [];

const walkMarkdown = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkMarkdown(absolute));
    else if (entry.name.toLowerCase().endsWith('.md')) result.push(path.relative(root, absolute).replaceAll('\\', '/'));
  }
  return result;
};

const markdownFiles = [
  ...(await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map(entry => entry.name),
  ...await walkMarkdown(path.join(root, 'docs'))
];
for (const file of markdownFiles) {
  if (!expected.has(file)) errors.push(`Unexpected or legacy Markdown file: ${file}`);
}
for (const file of expected) {
  try { await access(path.join(root, file)); } catch { errors.push(`Missing document: ${file}`); }
}

for (const [zhFile, enFile] of pairs) {
  const zh = await readFile(path.join(root, zhFile), 'utf8');
  const en = await readFile(path.join(root, enFile), 'utf8');
  const zhTarget = path.basename(enFile);
  const enTarget = path.basename(zhFile);
  if (zh.trimStart().split(/\r?\n/, 1)[0] !== `[English](${zhTarget})`) errors.push(`${zhFile}: missing top English switch`);
  if (en.trimStart().split(/\r?\n/, 1)[0] !== `[简体中文](${enTarget})`) errors.push(`${enFile}: missing top Chinese switch`);
}

for (const file of expected) {
  const absolute = path.join(root, file);
  const source = await readFile(absolute, 'utf8');
  const links = [...source.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)].map(match => match[1].trim().replace(/^<|>$/g, ''));
  for (const rawTarget of links) {
    const target = rawTarget.split('#', 1)[0].split('?', 1)[0];
    if (!target || /^(?:https?:|mailto:|data:)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(absolute), decodeURIComponent(target));
    try { await access(resolved); } catch { errors.push(`${file}: broken relative link ${rawTarget}`); }
  }
}

const legacyName = ['Mi', 'Sub'].join('');
const legacyOwner = ['im', 'zyb'].join('');
const expectedZhFooter = `许可证：[MIT](LICENSE) · 来源参考：[${legacyName}](https://github.com/${legacyOwner}/${legacyName})`;
const expectedEnFooter = `License: [MIT](LICENSE) · Reference: [${legacyName}](https://github.com/${legacyOwner}/${legacyName})`;
for (const file of expected) {
  const source = await readFile(path.join(root, file), 'utf8');
  const matchingLines = source.split(/\r?\n/).filter(line => line.toLowerCase().includes(legacyName.toLowerCase()) || line.includes(legacyOwner));
  const allowed = file === 'README.md' ? [expectedZhFooter] : file === 'README_EN.md' ? [expectedEnFooter] : [];
  if (JSON.stringify(matchingLines) !== JSON.stringify(allowed)) errors.push(`${file}: legacy reference is outside the allowed footer`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Documentation check passed: ${expected.size} files, ${pairs.length} language pairs.`);
