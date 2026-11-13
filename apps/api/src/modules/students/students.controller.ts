import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { MAX_UPLOAD_BYTES, UPLOAD_THROTTLE } from '../files/files.service';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { CancelEnrollmentDto, ChangeClassDto, DuplicateDecisionDto, EnrollStudentDto, GuardianInput, ReenrollDto, UpdateStudentDto, WithdrawDto } from './students.dto';
import { StudentsService } from './students.service';

@ApiTags('Élèves')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(private s: StudentsService) {}

  @Get() @Can('students.read')
  list(@CurrentActor() a: Actor, @Query('q') q?: string, @Query('classId') classId?: string) {
    return this.s.list(a, q, classId);
  }

  /** Élèves de l'année précédente (ou d'une année passée choisie) pas encore inscrits pour l'année en cours. */
  @Get('reenrollment') @Can('students.write')
  reenrollmentCandidates(@CurrentActor() a: Actor, @Query('fromYearId') fromYearId?: string) {
    return this.s.reenrollmentCandidates(a, fromYearId);
  }

  /** Doublons possibles : signalés à l'inscription ou repérés dans la base, à trancher par la direction. */
  @Get('duplicates') @Can('students.validate')
  duplicates(@CurrentActor() a: Actor) {
    return this.s.duplicateReviews(a);
  }

  @Post('duplicates/decision') @Can('students.validate')
  decideDuplicate(@CurrentActor() a: Actor, @Body() dto: DuplicateDecisionDto) {
    return this.s.decideDuplicate(a, dto);
  }

  @Get(':id') @Can('students.read')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.s.get(a, id);
  }

  @Post() @Can('students.write')
  enroll(@CurrentActor() a: Actor, @Body() dto: EnrollStudentDto) {
    return this.s.enroll(a, dto);
  }

  @Patch(':id') @Can('students.write')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStudentDto) {
    return this.s.update(a, id, dto);
  }

  @Post(':id/photo') @Can('students.write')
  @ApiConsumes('multipart/form-data')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  setPhoto(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.s.setPhoto(a, id, file);
  }

  @Delete(':id/photo') @Can('students.write')
  removePhoto(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.s.setPhoto(a, id);
  }

  /** Pièces du dossier : champ « file » (photo ou PDF) et champ « label » (nom de la pièce). */
  @Post(':id/files') @Can('students.write')
  @ApiConsumes('multipart/form-data')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  addFile(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body('label') label: string, @UploadedFile() file?: Express.Multer.File) {
    return this.s.addFile(a, id, label, file);
  }

  @Patch(':id/files/:fileId') @Can('students.write')
  @ApiConsumes('multipart/form-data')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  updateFile(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @Body('label') label?: string, @UploadedFile() file?: Express.Multer.File) {
    return this.s.updateFile(a, id, fileId, label, file);
  }

  @Delete(':id/files/:fileId') @Can('students.write')
  removeFile(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string) {
    return this.s.removeFile(a, id, fileId);
  }

  @Post(':id/guardians') @Can('students.write')
  addGuardian(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GuardianInput) {
    return this.s.addGuardian(a, id, dto);
  }

  @Post(':id/class') @Can('students.write')
  changeClass(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeClassDto) {
    return this.s.changeClass(a, id, dto);
  }

  @Post(':id/withdraw') @Can('students.write')
  withdraw(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawDto) {
    return this.s.withdraw(a, id, dto);
  }

  /** Réinscription pour l'année en cours, sur le même dossier (même matricule, historique conservé). */
  @Post(':id/reenroll') @Can('students.write')
  reenroll(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReenrollDto) {
    return this.s.reenroll(a, id, dto);
  }

  /** Annulation de l'inscription de l'année en cours (direction, avec un motif). Rien n'est supprimé. */
  @Post(':id/enrollment/cancel') @Can('students.validate')
  cancelEnrollment(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelEnrollmentDto) {
    return this.s.cancelEnrollment(a, id, dto);
  }
}
