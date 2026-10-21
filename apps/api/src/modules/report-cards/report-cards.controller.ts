import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { ReportCardsService } from './report-cards.service';

class CouncilEntryDto {
  @IsUUID() studentId: string;
  @IsOptional() @IsString() @MaxLength(500) appreciation?: string;
  @IsOptional() @IsString() @MaxLength(120) councilDecision?: string;
}
class CouncilDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => CouncilEntryDto) entries: CouncilEntryDto[];
}
class AnnualEntryDto {
  @IsUUID() studentId: string;
  @IsOptional() @IsIn(['ADMIS', 'NON_ADMIS', null]) outcome: 'ADMIS' | 'NON_ADMIS' | null;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
class AnnualDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AnnualEntryDto) entries: AnnualEntryDto[];
}
class ReasonDto {
  @IsString() @MaxLength(300) reason: string;
}

@ApiTags('Bulletins')
@ApiBearerAuth()
@Controller('report-cards')
export class ReportCardsController {
  constructor(private s: ReportCardsService) {}

  @Get('runs') @Can('reportcards.control', 'reportcards.appreciate')
  runs(@CurrentActor() a: Actor, @Query('termId', ParseUUIDPipe) termId: string) { return this.s.runs(a, termId); }

  @Get('runs/:classId/:termId') @Can('reportcards.control', 'reportcards.appreciate')
  preview(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) c: string, @Param('termId', ParseUUIDPipe) t: string) { return this.s.preview(a, c, t); }

  @Put('runs/:classId/:termId/council') @Can('reportcards.control', 'reportcards.appreciate')
  council(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) c: string, @Param('termId', ParseUUIDPipe) t: string, @Body() dto: CouncilDto) {
    return this.s.saveCouncil(a, c, t, dto.entries);
  }

  @Post('runs/:classId/:termId/advance') @Can('reportcards.control', 'reportcards.appreciate')
  advance(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) c: string, @Param('termId', ParseUUIDPipe) t: string) { return this.s.advance(a, c, t); }

  @Post('runs/:classId/:termId/reopen') @Can('reportcards.validate')
  reopen(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) c: string, @Param('termId', ParseUUIDPipe) t: string, @Body() dto: ReasonDto) {
    return this.s.reopen(a, c, t, dto.reason);
  }

  @Get('annual/:classId') @Can('reportcards.control', 'reportcards.appreciate')
  annual(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) c: string) { return this.s.annual(a, c); }

  @Put('annual/:classId') @Can('reportcards.validate')
  saveAnnual(@CurrentActor() a: Actor, @Param('classId', ParseUUIDPipe) c: string, @Body() dto: AnnualDto) {
    return this.s.saveAnnual(a, c, dto.entries.map((e) => ({ ...e, outcome: e.outcome ?? null })));
  }

  @Get('students/:id') @Can('reportcards.read')
  forStudent(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.forStudent(a, id); }

  @Get(':id') @Can('reportcards.read')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.get(a, id); }
}
