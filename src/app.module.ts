import { Module } from '@nestjs/common';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
