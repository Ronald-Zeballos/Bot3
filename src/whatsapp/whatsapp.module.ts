import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { SheetsService } from '../sheets/sheets.service';
import { PdfService } from '../pdf/pdf.service';

@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService, SheetsService, PdfService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
