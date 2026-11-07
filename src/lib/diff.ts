// Small line diff → unified format, for reviewing the Assistant's code changes. Trims the common
// head and tail first (edits are usually local), then runs an LCS on what's left.

export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: { t: " " | "-" | "+"; s: string }[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: " ", s: a[i] });
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((s) => ops.push({ t: "-", s }));
    midB.forEach((s) => ops.push({ t: "+", s }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = midA[i] === midB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: " ", s: midA[i] });
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: "-", s: midA[i++] });
      else ops.push({ t: "+", s: midB[j++] });
    }
    while (i < n) ops.push({ t: "-", s: midA[i++] });
    while (j < m) ops.push({ t: "+", s: midB[j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: " ", s: a[i] });

  const head = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}`;
  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return `${head}\n(no changes)`;
  // group changes into hunks with context
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length - 1, k + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }
  const out = [head];
  for (const [lo, hi] of hunks) {
    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < lo; k++) {
      if (ops[k].t !== "+") oldStart++;
      if (ops[k].t !== "-") newStart++;
    }
    const slice = ops.slice(lo, hi + 1);
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldLen ? oldStart : oldStart - 1},${oldLen} +${newLen ? newStart : newStart - 1},${newLen} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
  }
  return out.join("\n");
}
