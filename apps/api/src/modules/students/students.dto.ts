import { Sex } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, ValidateNested,
} from 'class-validator';

export class GuardianInput {
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsString() @MaxLength(40) relation: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class EnrollStudentDto {
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsOptional() @IsEnum(Sex) sex?: Sex;
  @IsOptional() @IsDateString() birthDate?: string;
  @IsOptional() @IsString() @MaxLength(120) birthPlace?: string;
  @IsOptional() @IsString() @MaxLength(300) allergies?: string;
  @IsUUID() classId: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => GuardianInput) guardians: GuardianInput[];
  /// Crée un compte élève (collège et lycée), identifiant = matricule.
  @IsOptional() @IsBoolean() createStudentAccount?: boolean;
  /// Crée la facture des frais de la classe à partir du catalogue.
  @IsOptional() @IsBoolean() createInvoices?: boolean;
  /// Ancien élève : frais de réinscription au lieu de ceux d'inscription.
  @IsOptional() @IsBoolean() returning?: boolean;
  @IsOptional() @IsUUID() applicationId?: string;
}

export class UpdateStudentDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsEnum(Sex) sex?: Sex;
  @IsOptional() @IsDateString() birthDate?: string;
  @IsOptional() @IsString() birthPlace?: string;
  @IsOptional() @IsString() allergies?: string;
}

export class ChangeClassDto {
  @IsUUID() classId: string;
}

export class WithdrawDto {
  @IsEnum(['TRANSFERRED', 'WITHDRAWN']) status: 'TRANSFERRED' | 'WITHDRAWN';
  @IsString() @MaxLength(300) reason: string;
}
