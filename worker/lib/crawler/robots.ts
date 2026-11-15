/**
 * Minimal, dependency-free robots.txt support.
 * The crawler only reads public pages a site owner allows to be crawled; it
 * never attempts to bypass a CAPTCHA, a login wall or a paywall.
 */

export type RobotsRules = {
  policy: 'allowed' | 'disallowed' | 'missing' | 'error';
  rules: Array<{ allow: boolean; path: string }>;
};

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current!.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow') current.rules.push({ allow: true, path: value || '/' });
    if (key === 'disallow') current.rules.push({ allow: false, path: value || '/' });
  }

  const token = userAgent.toLowerCase();
  const specific = groups.filter((group) => group.agents.some((agent) => agent !== '*' && token.includes(agent)));
  const wildcard = groups.filter((group) => group.agents.includes('*'));
  const chosen = specific.length ? specific : wildcard;
  const rules = chosen.flatMap((group) => group.rules);

  return { policy: 'allowed', rules };
}

export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  if (!rules.rules.length) return true;
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules.rules) {
    if (rule.path === '') continue;
    const pattern = rule.path.replace(/\*/g, '.*');
    const matches = new RegExp(`^${pattern}`).test(path);
    if (!matches) continue;
    if (!best || rule.path.length > best.length) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best ? best.allow : true;
}
