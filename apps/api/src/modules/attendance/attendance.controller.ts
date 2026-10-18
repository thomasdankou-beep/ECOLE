import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AttendanceStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { MAX_UPLOAD_BYTES } from '../files/files.service';
import { AttendanceService } from './attendance.service';

class RecordInput {
  @IsUUID() studentId: string;
  @IsEnum(AttendanceStatus) status: AttendanceStatus;
  @IsOptional() @IsInt() @Min(1) minutesLate?: number;
}
class RollCallDto {
  @IsUUID() classId: string;
  @IsOptional() @IsUUID() classSubjectId?: string;
  @IsDateString() date: string;
  @IsInt() startMinute: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RecordInput) records: RecordInput[];
}
class JustifyDto {
  @IsString() @MaxLength(300) reason: string;
}
class ReviewDto {
  @IsBoolean() accept: boolean;
  @IsOptional() @IsString() @MaxLength(300) comment?: string;
}
class SanctionDto {
  @IsUUID() studentId: string;
  @IsString() @MaxLength(80) kind: string;
  @IsString() @MaxLength(500) reason: string;
  @IsDateString() date: string;
}
class DecisionDto {
  @IsBoolean() validate: boolean;
}

@ApiTags('Vie scolaire')
@ApiBearerAuth()
@Controller()
export class AttendanceController {
  constructor(private s: AttendanceService) {}

  @Get('attendance/my-courses') @Can('attendance.take')
  myCourses(@CurrentActor() a: Actor, @Query('date') date?: string) { return this.s.myCourses(a, date); }

  @Get('attendance/sheet') @Can('attendance.take')
  sheet(@CurrentActor() a: Actor, @Query('classId', ParseUUIDPipe) classId: string, @Query('date') date: string, @Query('startMinute', ParseIntPipe) startMinute: number) {
    return this.s.sheet(a, classId, date, startMinute);
  }

  @Post('attendance') @Can('attendance.take')
  rollCall(@CurrentActor() a: Actor, @Body() dto: RollCallDto) { return this.s.rollCall(a, dto); }

  @Get('attendance/absences') @Can('attendance.read')
  absences(
    @CurrentActor() a: Actor, @Query('from') from?: string, @Query('to') to?: string, @Query('classId') classId?: string,
    @Query('studentId') studentId?: string, @Query('justification') justification?: string,
  ) {
    return this.s.absences(a, { from, to, classId, studentId, justification });
  }

  @Get('attendance/today') @Can('attendance.review', 'dashboard.read')
  today(@CurrentActor() a: Actor, @Query('date') date?: string) { return this.s.today(a, date); }

  @Post('attendance/records/:id/justify') @Can('attendance.justify')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  justify(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: JustifyDto, @UploadedFile() file?: Express.Multer.File) {
    return this.s.justify(a, id, dto.reason, file);
  }

  @Post('attendance/records/:id/review') @Can('attendance.review')
  review(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto) { return this.s.review(a, id, dto.accept, dto.comment); }

  @Get('sanctions') @Can('sanctions.read')
  sanctions(@CurrentActor() a: Actor, @Query('studentId') studentId?: string) { return this.s.sanctions(a, studentId); }

  @Post('sanctions') @Can('sanctions.propose', 'sanctions.manage')
  createSanction(@CurrentActor() a: Actor, @Body() dto: SanctionDto) { return this.s.createSanction(a, dto); }

  @Post('sanctions/:id/decision') @Can('sanctions.validate')
  decide(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) { return this.s.decideSanction(a, id, dto.validate); }
}
