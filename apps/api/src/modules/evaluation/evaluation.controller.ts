import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AssessmentKind } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { EvaluationService } from './evaluation.service';

class AssessmentDto {
  @IsUUID() classSubjectId: string;
  @IsUUID() termId: string;
  @IsString() @MaxLength(120) title: string;
  @IsEnum(AssessmentKind) kind: AssessmentKind;
  @IsNumber() @Min(0.25) @Max(10) weight: number;
  @IsOptional() @IsNumber() @Min(1) @Max(100) maxScore?: number;
  @IsDateString() date: string;
}
class AssessmentUpdateDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsEnum(AssessmentKind) kind?: AssessmentKind;
  @IsOptional() @IsNumber() @Min(0.25) @Max(10) weight?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(100) maxScore?: number;
  @IsOptional() @IsDateString() date?: string;
}
class GradeDto {
  @IsUUID() studentId: string;
  @IsOptional() @IsNumber() score: number | null;
  @IsOptional() @IsBoolean() absent?: boolean;
  @IsOptional() @IsBoolean() exempt?: boolean;
  @IsOptional() @IsString() @MaxLength(200) comment?: string;
}
class GradesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => GradeDto) grades: GradeDto[];
}
class AppreciationDto {
  @IsUUID() studentId: string;
  @IsUUID() classSubjectId: string;
  @IsUUID() termId: string;
  @IsString() @MaxLength(500) text: string;
}

@ApiTags('Évaluation')
@ApiBearerAuth()
@Controller('evaluation')
export class EvaluationController {
  constructor(private s: EvaluationService) {}

  @Get('class-subjects') @Can('grades.write', 'reportcards.control')
  classSubjects(@CurrentActor() a: Actor) { return this.s.myClassSubjects(a); }

  /** Un comptable n'a pas « grades.read » : il ne voit jamais les notes. */
  @Get('gradebook') @Can('grades.write', 'reportcards.control')
  gradebook(@CurrentActor() a: Actor, @Query('classSubjectId', ParseUUIDPipe) cs: string, @Query('termId', ParseUUIDPipe) termId: string) {
    return this.s.gradebook(a, cs, termId);
  }

  @Post('assessments') @Can('grades.write')
  create(@CurrentActor() a: Actor, @Body() dto: AssessmentDto) { return this.s.createAssessment(a, dto); }

  @Patch('assessments/:id') @Can('grades.write')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssessmentUpdateDto) { return this.s.updateAssessment(a, id, dto); }

  @Put('assessments/:id/grades') @Can('grades.write')
  grades(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GradesDto) {
    return this.s.saveGrades(a, id, dto.grades.map((g) => ({ ...g, score: g.score ?? null })));
  }

  @Post('assessments/:id/publish') @Can('grades.write')
  publish(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.publish(a, id); }

  @Put('appreciations') @Can('reportcards.appreciate')
  appreciation(@CurrentActor() a: Actor, @Body() dto: AppreciationDto) { return this.s.saveAppreciation(a, dto); }

  @Get('students/:id') @Can('grades.read')
  student(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query('termId') termId?: string) { return this.s.studentGrades(a, id, termId); }
}
