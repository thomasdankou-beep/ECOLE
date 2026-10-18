import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
