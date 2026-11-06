import { serveApiDocs } from './bootstrap';

describe('Documentation de l’API (SEC-045)', () => {
  it('fermée en production, sauf API_DOCS=true ; ouverte en développement, sauf API_DOCS=false', () => {
    expect(serveApiDocs({ NODE_ENV: 'production' })).toBe(false);
    expect(serveApiDocs({ NODE_ENV: 'production', API_DOCS: 'false' })).toBe(false);
    expect(serveApiDocs({ NODE_ENV: 'production', API_DOCS: 'true' })).toBe(true);
    expect(serveApiDocs({ NODE_ENV: 'development' })).toBe(true);
    expect(serveApiDocs({})).toBe(true);
    expect(serveApiDocs({ NODE_ENV: 'development', API_DOCS: 'false' })).toBe(false);
  });
});
