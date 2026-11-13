import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditService } from './common/audit.service';
import { AuthGuard } from './common/auth';
import { PrismaService } from './common/prisma.service';
import { ScopeService } from './common/scope.service';
import { HealthController } from './health.controller';
import { AdmissionsController, AdmissionsService } from './modules/admissions/admissions';
import { AttendanceController } from './modules/attendance/attendance.controller';
import { AttendanceService } from './modules/attendance/attendance.service';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { RecoveryController, RecoveryService } from './modules/auth/recovery';
import { CommunicationController, CommunicationService, PublicService } from './modules/communication/communication';
import { DashboardController, DashboardService } from './modules/dashboard/dashboard';
import { DocumentsController, DocumentsService } from './modules/documents/documents';
import { EvaluationController } from './modules/evaluation/evaluation.controller';
import { EvaluationService } from './modules/evaluation/evaluation.service';
import { FilesController } from './modules/files/files.controller';
import { FilesService } from './modules/files/files.service';
import { AntivirusService } from './modules/files/antivirus.service';
import { FinanceController } from './modules/finance/finance.controller';
import { FinanceService } from './modules/finance/finance.service';
import { InternshipsController, InternshipsService } from './modules/internships/internships';
import { LessonsController, LessonsService } from './modules/lessons/lessons';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { NotificationsService } from './modules/notifications/notifications.service';
import { PlatformController, PlatformDb, PlatformGuard, PlatformService } from './modules/platform/platform';
import { PlatformGroupsController, PlatformGroupsService } from './modules/platform/groups';
import { GroupAuthController, GroupAuthService, GroupGuard, GroupHostGuard } from './modules/group/group-auth';
import { GroupConsoleController, GroupConsoleService } from './modules/group/group-console';
import { GroupDb } from './modules/group/group-db';
import { PaymentsController } from './modules/payments/payments.controller';
import { PaymentsService } from './modules/payments/payments.service';
import { ReportCardsController } from './modules/report-cards/report-cards.controller';
import { ReportCardsService } from './modules/report-cards/report-cards.service';
import { HonorsController, HonorsService } from './modules/communication/honors';
import { SettingsController } from './modules/settings/settings.controller';
import { SettingsService } from './modules/settings/settings.service';
import { StudentsController } from './modules/students/students.controller';
import { StudentsService } from './modules/students/students.service';
import { TimetableController } from './modules/timetable/timetable.controller';
import { TimetableService } from './modules/timetable/timetable.service';

/** Socle partagé par tous les modules : base, périmètre, audit, notifications, fichiers. */
@Global()
@Module({
  providers: [PrismaService, ScopeService, AuditService, NotificationsService, FilesService, AntivirusService],
  exports: [PrismaService, ScopeService, AuditService, NotificationsService, FilesService],
})
class CoreModule {}

/**
 * Monolithe modulaire (master prompt §6) : un contrôleur et un service par domaine,
 * tous derrière le même garde d'authentification et d'autorisation.
 */
@Module({
  imports: [
    CoreModule,
    JwtModule.register({}),
    // Limitation des tentatives (CDC §6.1) ; désactivée seulement pour les tests automatisés. Message en français
    // (il s'affiche tel quel sur les pages de connexion), au lieu de « ThrottlerException: Too Many Requests ».
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
      errorMessage: 'Trop de demandes en peu de temps : patientez une minute, puis réessayez.',
    }),
  ],
  controllers: [
    HealthController, AuthController, RecoveryController, SettingsController, StudentsController, AdmissionsController, DocumentsController,
    TimetableController, LessonsController, AttendanceController, EvaluationController, ReportCardsController,
    FinanceController, PaymentsController, CommunicationController, NotificationsController, DashboardController, FilesController,
    InternshipsController, PlatformController, PlatformGroupsController, HonorsController, GroupAuthController, GroupConsoleController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    AuthService, RecoveryService, SettingsService, StudentsService, AdmissionsService, DocumentsService, TimetableService, LessonsService,
    AttendanceService, EvaluationService, ReportCardsService, FinanceService, PaymentsService, CommunicationService,
    PublicService, DashboardService, InternshipsService, PlatformDb, PlatformGuard, PlatformService, PlatformGroupsService, HonorsService,
    // Console des groupes (lot G2) : connexion à la base avec le rôle dédié erp_group.
    GroupDb, GroupHostGuard, GroupGuard, GroupAuthService, GroupConsoleService,
  ],
})
export class AppModule {}
