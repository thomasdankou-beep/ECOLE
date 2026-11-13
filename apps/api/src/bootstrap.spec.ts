import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AllExceptionsFilter, serveApiDocs } from './bootstrap';

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

describe('Erreurs renvoyées au client (lot G4)', () => {
  const send = (exception: unknown) => {
    const out: { status?: number; body?: unknown } = {};
    const res = { status: (s: number) => { out.status = s; return { json: (b: unknown) => { out.body = b; } }; } };
    new AllExceptionsFilter().catch(exception, { switchToHttp: () => ({ getResponse: () => res }) } as never);
    return out;
  };

  it('seule la liste des dossiers qui ressemblent à un élève accompagne le message ; rien d’autre ne sort', () => {
    const candidates = [{ id: null, matricule: 'FIC-26-0001', otherSite: true }];
    expect(send(new ConflictException({ statusCode: 409, code: 'DOUBLON_POSSIBLE', message: 'Un dossier qui ressemble…', candidates }))).toEqual({
      status: 409, body: { statusCode: 409, message: 'Un dossier qui ressemble…', code: 'DOUBLON_POSSIBLE', candidates },
    });
    expect(send(new ForbiddenException({ message: 'Refusé', code: 'AUTRE', candidates, secret: 'fuite' }))).toEqual({ status: 403, body: { statusCode: 403, message: 'Refusé' } });
    expect(send(new ConflictException({ message: 'Doublon', code: 'DOUBLON_POSSIBLE', candidates: 'pas une liste' }))).toEqual({ status: 409, body: { statusCode: 409, message: 'Doublon' } });
  });
});
