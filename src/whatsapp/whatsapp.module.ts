import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [], // No se necesita importar nada si no usas otros servicios
  controllers: [WhatsappController],
  providers: [WhatsappService],
})
export class WhatsappModule {}