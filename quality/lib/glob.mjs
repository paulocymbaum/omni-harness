const cache = new Map();

/** Converte glob (`**`, `*`, `?`, `{a,b}`) em RegExp ancorada. Caminhos em formato POSIX. */
export function globToRegex(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; inBraces = true; }
    else if (c === '}' && inBraces) { re += ')'; inBraces = false; }
    else if (c === ',' && inBraces) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

export function matchAny(file, globs = []) {
  return globs.some((g) => globToRegex(g).test(file));
}
