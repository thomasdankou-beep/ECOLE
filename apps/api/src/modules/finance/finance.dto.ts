import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class FeeTypeDto {
  @IsString() @MaxLength(120) name: string;
  @IsInt() @Min(0) amount: number;
  @IsOptional() @IsUUID() levelId?: string | null;
  @IsOptional() @IsUUID() trackId?: string | null;
  @IsOptional() @IsDateString() dueDate?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class InvoiceItemInput {
  @IsString() @MaxLength(160) label: string;
  @IsInt() @Min(1) amount: number;
  @IsOptional() @IsUUID() feeTypeId?: string;
}

export class InvoiceDto {
  @IsUUID() studentId: string;
  @IsString() @MaxLength(160) label: string;
  @IsDateString() dueDate: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceItemInput) items: InvoiceItemInput[];
}

export class BatchInvoiceDto {
  @IsUUID() feeTypeId: string;
  @IsOptional() @IsUUID() classId?: string;
}

export class DeskPaymentDto {
  @IsUUID() invoiceId: string;
  @IsInt() @Min(1) amount: number;
  @IsEnum(['CASH', 'CHEQUE', 'TRANSFER', 'MOBILE_MONEY_DESK']) method: Exclude<PaymentMethod, 'ONLINE'>;
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  /// Clé d'idempotence générée par l'interface : un double clic n'encaisse pas deux fois.
  @IsOptional() @IsString() @MaxLength(80) idempotencyKey?: string;
}

export class CancelReceiptDto {
  @IsString() @MaxLength(300) reason: string;
}

export class CashClosingDto {
  @IsInt() @Min(0) counted: number;
  @IsOptional() @IsString() @MaxLength(300) comment?: string;
}

export class RemindDto {
  @IsOptional() @IsUUID() classId?: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) studentIds?: string[];
}
