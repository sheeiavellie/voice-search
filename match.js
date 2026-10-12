// Matching what was said to the names in the city.
//
// Speech has no case and no punctuation, and a name has no spaces, so both
// fold to their letters and digits: "open browser", "openBrowser" and
// "open_browser" are one name. A request may wrap the name in other words
// ("go to …", "… function"), so it is tried in every form those words can be
// dropped from, longest first. And speech mishears a sound now and then, so a
// near miss still counts, for less than a hit.

export const fold = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Words that lead up to a name rather than being part of it.
const LEAD = new Set([
  "a", "an", "at", "find", "for", "go", "goto", "is", "jump", "look", "me",
  "open", "please", "search", "select", "show", "take", "the", "to", "where",
]);

// Words that say what kind of node is meant: "the parse function".
const KIND = {
  function: "function", func: "function", method: "method",
  type: "type", struct: "type", class: "type", interface: "type",
  variable: "variable", var: "variable", constant: "variable",
  package: "package", module: "package", folder: "package", directory: "package",
};

// requestForms splits a request into the forms the name may be in, folded,
// and the kind it names, if it names one.
export function requestForms(text) {
  const words = String(text || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  let kind = null;
  let end = words.length;
  if (end > 1 && KIND[words[end - 1]]) kind = KIND[words[--end]];
  const forms = [];
  if (end < words.length) forms.push(words.join(""));
  for (let start = 0; start < end; start++) {
    forms.push(words.slice(start, end).join(""));
    const word = words[start];
    if (KIND[word]) kind = kind || KIND[word];
    else if (!LEAD.has(word)) break;
  }
  return { forms: [...new Set(forms)].filter((form) => form.length >= 2), kind };
}

// distance is the edit distance between a and b, or max + 1 once it is
// certainly more than max.
export function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      least = Math.min(least, row[j]);
    }
    if (least > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

// score is how well a spoken form names a folded key: 100 for the name
// itself, then the start of a name, a name with a word too many, a name that
// holds the form, and a near miss. 0 is no match.
export function score(form, key) {
  if (!form || !key) return 0;
  if (form === key) return 100;
  if (form.length >= 3 && key.startsWith(form)) return 80 + (10 * form.length) / key.length;
  if (key.length >= 4 && form.startsWith(key)) return 70 + (10 * key.length) / form.length;
  if (form.length >= 4 && key.includes(form)) return 60 + (10 * form.length) / key.length;
  const longest = Math.max(form.length, key.length);
  const max = Math.floor(longest / 4);
  if (max < 1) return 0;
  const d = distance(form, key, max);
  return d <= max ? 90 - (80 * d) / longest : 0;
}

// createMatcher indexes the city's packages and declarations by their folded
// names and returns match(text, limit): the nodes the request may mean, best
// first, as { node, score }.
export function createMatcher(packages) {
  const entries = [];
  for (const pkg of packages) {
    const last = pkg.id.split("/").pop();
    entries.push({ node: pkg, keys: [...new Set([fold(pkg.name), fold(last)])].filter(Boolean) });
    for (const e of pkg.entities) {
      const keys = [fold(e.name)];
      if (e.recv) keys.push(fold(e.recv + e.name));
      entries.push({ node: e, keys: keys.filter(Boolean) });
    }
  }
  return function match(text, limit = 8) {
    const { forms, kind } = requestForms(text);
    if (!forms.length) return [];
    const hits = [];
    for (const entry of entries) {
      let best = 0;
      for (const form of forms) {
        for (const key of entry.keys) {
          const s = score(form, key);
          // A longer form says more, so it wins a tie.
          if (s) best = Math.max(best, s + form.length / 100);
        }
      }
      if (!best) continue;
      const node = entry.node;
      const nodeKind = node.kind === "external" ? "package" : node.kind;
      if (kind && nodeKind === kind) best += 6;
      if (node.change && node.change !== "same") best += 3;
      if (node.kind === "function" || node.kind === "method") best += 1;
      hits.push({ node, score: best });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  };
}
