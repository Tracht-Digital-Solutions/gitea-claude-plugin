/**
 * Minimal glob matching for repository paths and branch patterns.
 *
 * Supported syntax: `*` matches within one path segment, `**` across segments (`**\/` also matches
 * zero directories), `?` one character. Everything else is literal.
 */
export function globToRegExp(glob: string, options: { caseInsensitive?: boolean } = {}): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, options.caseInsensitive ? 'i' : '');
}

/** True when `name` matches the glob `pattern` (case-sensitive, as git ref names are). */
export function globMatch(pattern: string, name: string): boolean {
  return globToRegExp(pattern).test(name);
}

/** True when the string contains glob syntax. */
export function isGlob(value: string): boolean {
  return /[*?]/.test(value);
}
