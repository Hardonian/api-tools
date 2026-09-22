/**
 * Lightweight request router with pattern matching and middleware pipeline.
 */

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * Register a route.
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {string} pattern - URL pattern with :param placeholders
   * @param {Function} handler - async (request, env, ctx) => Response
   */
  add(method, pattern, handler) {
    const regex = this._patternToRegex(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, regex, handler });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  put(pattern, handler) { return this.add('PUT', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  /**
   * Match a request and return { handler, params } or null.
   */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = route.regex.exec(pathname);
      if (match) {
        const params = {};
        const keys = route.pattern.match(/:(\w+)/g) || [];
        keys.forEach((key, i) => { params[key.slice(1)] = match[i + 1]; });
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  /**
   * Convert '/api/v1/sources/:id/diffs' → regex with named groups.
   */
  _patternToRegex(pattern) {
    // Replace :param placeholders BEFORE escaping special chars
    const PLACEHOLDER = '___PARAM___';
    const paramNames = [];
    const withPlaceholders = pattern.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return PLACEHOLDER;
    });
    const escaped = withPlaceholders.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const final = escaped.replaceAll(PLACEHOLDER, '([^/]+)');
    return new RegExp(`^${final}$`);
  }
}
