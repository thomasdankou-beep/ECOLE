import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { MAX_UPLOAD_BYTES } from '../files/files.service';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { ChangeClassDto, EnrollStudentDto, GuardianInput, UpdateStudentDto, WithdrawDto } from './students.dto';
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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  addFile(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body('label') label: string, @UploadedFile() file?: Express.Multer.File) {
    return this.s.addFile(a, id, label, file);
  }

  @Patch(':id/files/:fileId') @Can('students.write')
  @ApiConsumes('multipart/form-data')
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
}
