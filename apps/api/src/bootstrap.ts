import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import type { Response } from 'express';
import helmet from 'helmet';
import { config } from './config';

/** Erreurs en français, sans fuite de détails techniques vers le client. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private log = new Logger('Erreur');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse() as any;
      const message = Array.isArray(body?.message) ? body.message.join(' · ') : body?.message ?? exception.message;
      return res.status(exception.getStatus()).json({ statusCode: exception.getStatus(), message });
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') return res.status(404).json({ statusCode: 404, message: 'Élément introuvable' });
      if (exception.code === 'P2002') return res.status(409).json({ statusCode: 409, message: 'Cet élément existe déjà' });
      if (exception.code === 'P2003') return res.status(400).json({ statusCode: 400, message: 'Référence invalide' });
    }
    this.log.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Une erreur est survenue. Réessayez dans un instant.' });
  }
}

/** Réglages communs à l'application réelle et aux tests de bout en bout. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.webOrigin, credentials: true });
  (app as any).set?.('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}

export function setupSwagger(app: INestApplication) {
  const doc = new DocumentBuilder()
    .setTitle('ERP scolaire — API')
    .setDescription('API REST versionnée /api/v1. Authentification par jeton Bearer ; en-tête X-Active-Role pour choisir le rôle actif.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
}
