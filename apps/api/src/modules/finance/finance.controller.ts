import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Can, CurrentActor } from '../../common/auth';
import { BatchInvoiceDto, CancelReceiptDto, CashClosingDto, DeskPaymentDto, FeeTypeDto, InvoiceDto, RemindDto } from './finance.dto';
import { FinanceService } from './finance.service';

@ApiTags('Finances')
@ApiBearerAuth()
@Controller('finance')
export class FinanceController {
  constructor(private s: FinanceService) {}

  @Get('dashboard') @Can('finance.write', 'dashboard.read')
  dashboard(@CurrentActor() a: Actor) { return this.s.dashboard(a); }

  @Get('fee-types') @Can('finance.write', 'settings.manage')
  feeTypes(@CurrentActor() a: Actor) { return this.s.feeTypes(a); }

  @Post('fee-types') @Can('finance.write')
  createFeeType(@CurrentActor() a: Actor, @Body() dto: FeeTypeDto) { return this.s.createFeeType(a, dto); }

  @Patch('fee-types/:id') @Can('finance.write')
  updateFeeType(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FeeTypeDto) { return this.s.updateFeeType(a, id, dto); }

  /** Parents : factures de leurs enfants seulement (périmètre appliqué par le service). */
  @Get('invoices') @Can('finance.read')
  invoices(@CurrentActor() a: Actor, @Query('studentId') studentId?: string, @Query('status') status?: string, @Query('classId') classId?: string) {
    return this.s.invoices(a, { studentId, status, classId });
  }

  @Post('invoices') @Can('finance.write')
  createInvoice(@CurrentActor() a: Actor, @Body() dto: InvoiceDto) { return this.s.createInvoice(a, dto); }

  @Post('invoices/batch') @Can('finance.write')
  batch(@CurrentActor() a: Actor, @Body() dto: BatchInvoiceDto) { return this.s.batchInvoice(a, dto); }

  @Post('invoices/:id/cancel') @Can('finance.write')
  cancelInvoice(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelReceiptDto) { return this.s.cancelInvoice(a, id, dto.reason); }

  @Post('payments/desk') @Can('finance.write')
  desk(@CurrentActor() a: Actor, @Body() dto: DeskPaymentDto) { return this.s.deskPayment(a, dto); }

  @Get('payments') @Can('finance.write')
  payments(@CurrentActor() a: Actor, @Query('status') status?: string, @Query('method') method?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.s.payments(a, { status, method, from, to });
  }

  @Get('payments/export.csv') @Can('finance.write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="encaissements.csv"')
  exportCsv(@CurrentActor() a: Actor, @Query('from') from?: string, @Query('to') to?: string) { return this.s.exportPaymentsCsv(a, from, to); }

  @Get('receipts/:id') @Can('finance.read')
  receipt(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.s.receipt(a, id); }

  @Post('receipts/:id/cancel') @Can('finance.write')
  cancelReceipt(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelReceiptDto) { return this.s.cancelReceipt(a, id, dto.reason); }

  @Get('unpaid') @Can('finance.write')
  unpaid(@CurrentActor() a: Actor, @Query('classId') classId?: string) { return this.s.unpaid(a, classId); }

  @Post('reminders') @Can('finance.write')
  remind(@CurrentActor() a: Actor, @Body() dto: RemindDto) { return this.s.remind(a, dto); }

  @Get('cash-closings') @Can('finance.write')
  closings(@CurrentActor() a: Actor) { return this.s.cashClosings(a); }

  @Post('cash-closings') @Can('finance.write')
  close(@CurrentActor() a: Actor, @Body() dto: CashClosingDto) { return this.s.closeCash(a, dto); }
}
