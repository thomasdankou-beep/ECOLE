import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './bootstrap';
import { config } from './config';

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 1);
  configureApp(app);
  setupSwagger(app);
  await app.listen(config.port);
  console.log(`API prête sur http://localhost:${config.port}/api/v1 — documentation : /api/docs`);
}

main();
