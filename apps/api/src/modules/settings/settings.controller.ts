import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { MAX_UPLOAD_BYTES } from '../files/files.service';
import { Actor, Can, CurrentActor } from '../../common/auth';
import {
  AcademicYearDto, AssignmentDto, BulkCoefficientDto, ClassDto, ClassSubjectDto, LevelDto, LevelUpdateDto, RoomDto, RoomUpdateDto,
  SiteDto, StaffDto, StaffUpdateDto, SubjectDto, SubjectUpdateDto, TenantSettingsDto, TrackDto, TrackUpdateDto,
} from './settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('Paramétrage')
@ApiBearerAuth()
@Controller()
export class SettingsController {
  constructor(private s: SettingsService) {}

  /** Référentiel (sites, niveaux, filières, matières, périodes) : lisible par tout le personnel pour les listes. */
  @Get('settings')
  @Can('students.read', 'finance.read')
  overview(@CurrentActor() a: Actor) {
    return this.s.overview(a);
  }

  @Patch('settings')
  @Can('settings.manage')
  updateSettings(@CurrentActor() a: Actor, @Body() dto: TenantSettingsDto) {
    return this.s.updateTenantSettings(a, dto.settings ?? {}, { name: dto.name, shortName: dto.shortName });
  }

  @Post('settings/identity/:kind') @Can('settings.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  setIdentityImage(@CurrentActor() a: Actor, @Param('kind') kind: string, @UploadedFile() file?: Express.Multer.File) {
    return this.s.setIdentityImage(a, imageKind(kind), file);
  }

  @Delete('settings/identity/:kind') @Can('settings.manage')
  removeIdentityImage(@CurrentActor() a: Actor, @Param('kind') kind: string) {
    return this.s.setIdentityImage(a, imageKind(kind));
  }

  @Post('sites') @Can('settings.manage')
  createSite(@CurrentActor() a: Actor, @Body() dto: SiteDto) { return this.s.createSite(a, dto); }

  @Patch('sites/:id') @Can('settings.manage')
  updateSite(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SiteDto) { return this.s.updateSite(a, id, dto); }

  @Post('academic-years') @Can('settings.manage')
  createYear(@CurrentActor() a: Actor, @Body() dto: AcademicYearDto) { return this.s.createYear(a, dto); }

  @Post('academic-years/:id/current') @Can('settings.manage')
  setCurrent(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.setCurrentYear(a, id); }

  @Post('levels') @Can('settings.manage')
  createLevel(@CurrentActor() a: Actor, @Body() dto: LevelDto) { return this.s.createLevel(a, dto); }

  @Post('tracks') @Can('settings.manage')
  createTrack(@CurrentActor() a: Actor, @Body() dto: TrackDto) { return this.s.createTrack(a, dto); }

  @Patch('levels/:id') @Can('settings.manage')
  updateLevel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LevelUpdateDto) { return this.s.updateLevel(a, id, dto); }

  @Patch('tracks/:id') @Can('settings.manage')
  updateTrack(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TrackUpdateDto) { return this.s.updateTrack(a, id, dto); }

  @Post('rooms') @Can('settings.manage')
  createRoom(@CurrentActor() a: Actor, @Body() dto: RoomDto) { return this.s.createRoom(a, dto); }

  @Patch('rooms/:id') @Can('settings.manage')
  updateRoom(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RoomUpdateDto) { return this.s.updateRoom(a, id, dto); }

  @Delete('rooms/:id') @Can('settings.manage')
  removeRoom(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.removeRoom(a, id); }

  @Post('subjects') @Can('settings.manage')
  createSubject(@CurrentActor() a: Actor, @Body() dto: SubjectDto) { return this.s.createSubject(a, dto); }

  @Patch('subjects/:id') @Can('settings.manage')
  updateSubject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubjectUpdateDto) { return this.s.updateSubject(a, id, dto); }

  @Put('class-subjects/bulk') @Can('settings.manage')
  bulkCoefficient(@CurrentActor() a: Actor, @Body() dto: BulkCoefficientDto) { return this.s.bulkCoefficient(a, dto); }

  @Get('classes') @Can('students.read', 'timetable.read')
  classes(@CurrentActor() a: Actor, @Query('yearId') yearId?: string) { return this.s.listClasses(a, yearId); }

  @Post('classes') @Can('settings.manage')
  createClass(@CurrentActor() a: Actor, @Body() dto: ClassDto) { return this.s.createClass(a, dto); }

  @Patch('classes/:id') @Can('settings.manage')
  updateClass(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ClassDto) { return this.s.updateClass(a, id, dto); }

  @Put('classes/:id/subjects') @Can('settings.manage')
  upsertSubject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ClassSubjectDto) { return this.s.upsertClassSubject(a, id, dto); }

  @Delete('class-subjects/:id') @Can('settings.manage')
  removeSubject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.removeClassSubject(a, id); }

  @Post('assignments') @Can('settings.manage')
  assign(@CurrentActor() a: Actor, @Body() dto: AssignmentDto) { return this.s.assign(a, dto); }

  @Delete('assignments/:id') @Can('settings.manage')
  unassign(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.unassign(a, id); }

  @Get('staff') @Can('users.manage')
  staff(@CurrentActor() a: Actor) { return this.s.listStaff(a); }

  @Post('staff') @Can('users.manage')
  createStaff(@CurrentActor() a: Actor, @Body() dto: StaffDto) { return this.s.createStaff(a, dto); }

  @Patch('staff/:id') @Can('users.manage')
  updateStaff(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StaffUpdateDto) { return this.s.updateStaff(a, id, dto); }

  @Post('users/:id/reset-password') @Can('users.manage')
  resetPassword(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.resetPassword(a, id); }
}

function imageKind(kind: string) {
  return kind === 'stamp' ? 'stamp' : kind === 'logo' ? 'logo' : 'signature';
}
