// 配置文件读写助手：JSON(带注释容错) / TOML(smol-toml) / dotenv / YAML
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

export function parseJsonc(text) {
  try { return { value: JSON.parse(text), error: null }; } catch (e0) { /* 继续尝试去注释 */ }
  const cleaned = stripJsonComments(text);
  try { return { value: JSON.parse(cleaned), error: null }; } catch (e) {
    return { value: null, error: e };
  }
}

export function stripJsonComments(text) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    if (c === ',' ) { // 尾逗号宽容：看下一个非空白符号
      let j = i + 1; while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

export function parseToml(text) {
  try { return { value: tomlParse(text), error: null }; }
  catch (e) { return { value: null, error: e }; }
}

export function stringifyToml(value) {
  return tomlStringify(value);
}

export function parseYaml(text) {
  try { return { value: yamlParse(text), error: null }; }
  catch (e) { return { value: null, error: e }; }
}

export function stringifyYaml(value) {
  return yamlStringify(value);
}

export function parseDotenv(text) {
  const doc = { order: [], values: {} };
  if (text === null) return doc;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) { doc.order.push(rawLine); continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { doc.order.push(rawLine); continue; }
    const [, key, restRaw] = m;
    let value = restRaw;
    const q = restRaw[0];
    if ((q === '"' || q === "'") && restRaw.endsWith(q)) value = restRaw.slice(1, -1);
    doc.values[key] = value;
    doc.order.push({ key });
  }
  return doc;
}

export function stringifyDotenv(doc) {
  return doc.order.map((item) => {
    if (typeof item === 'string') return item;
    const v = doc.values[item.key];
    if (v === undefined) return `# ${item.key}=`;
    return `${item.key}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`;
  }).join('\n') + '\n';
}

export function setDotenv(doc, key, value) {
  if (doc.values[key] === undefined) doc.order.push({ key });
  doc.values[key] = String(value);
}

export function deleteDotenv(doc, key) {
  delete doc.values[key];
  doc.order = doc.order.filter((i) => typeof i === 'string' || i.key !== key);
}
