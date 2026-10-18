import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TimetableChangeKind } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { TimetableService } from './timetable.service';

class SlotDto {
  @IsUUID() classSubjectId: string;
  @IsOptional() @IsUUID() roomId?: string | null;
  @IsInt() @Min(1) @Max(6) dayOfWeek: number;
  @IsInt() @Min(360) @Max(1260) startMinute: number;
  @IsInt() @Min(360) @Max(1320) endMinute: number;
}

class SlotUpdateDto {
  @IsOptional() @IsUUID() roomId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(6) dayOfWeek?: number;
  @IsOptional() @IsInt() @Min(360) @Max(1260) startMinute?: number;
  @IsOptional() @IsInt() @Min(360) @Max(1320) endMinute?: number;
}

class ChangeDto {
  @IsDateString() date: string;
  @IsEnum(TimetableChangeKind) kind: TimetableChangeKind;
  @IsOptional() @IsDateString() newDate?: string;
  @IsOptional() @IsInt() newStartMinute?: number;
  @IsOptional() @IsInt() newEndMinute?: number;
  @IsOptional() @IsUUID() newRoomId?: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

@ApiTags('Emploi du temps')
@ApiBearerAuth()
@Controller('timetable')
export class TimetableController {
  constructor(private s: TimetableService) {}

  @Get() @Can('timetable.read')
  week(@CurrentActor() a: Actor, @Query('classId') classId?: string, @Query('teacherId') teacherId?: string, @Query('roomId') roomId?: string, @Query('week') week?: string) {
    return this.s.week(a, { classId, teacherId, roomId, week });
  }

  @Post('slots') @Can('timetable.manage')
  create(@CurrentActor() a: Actor, @Body() dto: SlotDto) { return this.s.createSlot(a, dto); }

  @Patch('slots/:id') @Can('timetable.manage')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SlotUpdateDto) { return this.s.updateSlot(a, id, dto); }

  @Delete('slots/:id') @Can('timetable.manage')
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.deleteSlot(a, id); }

  @Post('slots/:id/changes') @Can('timetable.manage')
  change(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeDto) { return this.s.addChange(a, id, dto); }

  @Delete('changes/:id') @Can('timetable.manage')
  removeChange(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.removeChange(a, id); }
}
