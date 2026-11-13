import { Sex } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested,
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
  /// Ancien élève sans dossier dans Cahiora (avant son arrivée dans l'outil) : frais de réinscription au lieu de ceux
  /// d'inscription. Un élève qui a déjà un dossier se réinscrit sur ce dossier (POST /students/:id/reenroll).
  @IsOptional() @IsBoolean() returning?: boolean;
  @IsOptional() @IsUUID() applicationId?: string;
  /// Doublon possible signalé (409) : la personne confirme qu'il s'agit d'un autre élève, avec un motif.
  /// Le dossier est créé et la paire est soumise à la direction ; rien n'est fusionné.
  @IsOptional() @IsBoolean() confirmNotDuplicate?: boolean;
  @IsOptional() @IsString() @MaxLength(300) duplicateNote?: string;
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
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
  /// Date de sortie (lot G4) : l'élève ne compte plus parmi les inscrits à partir de ce jour.
  @IsDateString() exitDate: string;
}

/** Réinscription d'un élève qui a déjà un dossier dans l'école, pour l'année en cours (lot G4). */
export class ReenrollDto {
  @IsUUID() classId: string;
  /// Crée les factures des frais de réinscription de la classe (catalogue).
  @IsOptional() @IsBoolean() createInvoices?: boolean;
  /// Pré-inscription d'un ancien élève, marquée « inscrit » une fois l'élève réinscrit sur son dossier.
  @IsOptional() @IsUUID() applicationId?: string;
}

/** Annulation d'une inscription par la direction : jamais supprimée, motif obligatoire (lot G4). */
export class CancelEnrollmentDto {
  @IsString() @MinLength(5) @MaxLength(300) reason: string;
}

/** Décision de la direction sur deux dossiers qui se ressemblent (lot G4) ; aucune fusion automatique. */
export class DuplicateDecisionDto {
  @IsUUID() studentId: string;
  @IsUUID() otherId: string;
  @IsEnum(['DIFFERENT', 'SAME']) decision: 'DIFFERENT' | 'SAME';
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
