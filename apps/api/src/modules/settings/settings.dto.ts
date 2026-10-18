import { Cycle, RoleCode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsNumber, IsObject, IsOptional,
  IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class SiteDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class TermInput {
  @IsString() name: string;
  @IsDateString() startDate: string;
  @IsDateString() endDate: string;
  @IsOptional() @IsNumber() weight?: number;
}

export class AcademicYearDto {
  @IsString() @MaxLength(20) label: string;
  @IsDateString() startDate: string;
  @IsDateString() endDate: string;
  @IsOptional() @IsBoolean() isCurrent?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => TermInput) terms: TermInput[];
}

export class LevelDto {
  @IsString() @MaxLength(60) name: string;
  @IsEnum(Cycle) cycle: Cycle;
  @IsInt() position: number;
}

export class TrackDto {
  @IsString() @MaxLength(20) code: string;
  @IsString() @MaxLength(120) name: string;
  @IsEnum(Cycle) cycle: Cycle;
}

export class RoomDto {
  @IsUUID() siteId: string;
  @IsString() @MaxLength(60) name: string;
}

export class SubjectDto {
  @IsString() @MaxLength(20) code: string;
  @IsString() @MaxLength(120) name: string;
}

export class ClassDto {
  @IsString() @MaxLength(60) name: string;
  @IsUUID() siteId: string;
  @IsUUID() levelId: string;
  @IsOptional() @IsUUID() trackId?: string | null;
  @IsOptional() @IsInt() @Min(1) capacity?: number | null;
  @IsOptional() @IsUUID() headTeacherId?: string | null;
}

export class ClassSubjectDto {
  @IsUUID() subjectId: string;
  @IsNumber() @Min(0) @Max(20) coefficient: number;
}

export class AssignmentDto {
  @IsUUID() teacherId: string;
  @IsUUID() classSubjectId: string;
}

export class RoleInput {
  @IsEnum(RoleCode) role: RoleCode;
  @IsOptional() @IsUUID() siteId?: string | null;
}

export class StaffDto {
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => RoleInput) roles: RoleInput[];
}

export class StaffUpdateDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RoleInput) roles?: RoleInput[];
}

export class TenantSettingsDto {
  @IsObject() settings: Record<string, unknown>;
}
