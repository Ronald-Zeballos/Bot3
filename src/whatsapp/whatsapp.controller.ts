import { Controller, Post, Get, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('webhook')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get()
  verifyWebhook(@Query('hub.mode') mode: string, @Query('hub.challenge') challenge: string, @Query('hub.verify_token') token: string): string {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook verificado con éxito!');
      return challenge;
    }
    return 'Token de verificación incorrecto.';
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() body: any) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const from = message.from;

      if (message.type === 'text') {
        const userText = message.text.body;
        const response = await this.whatsappService.generarRespuesta(userText); 
        await this.whatsappService.sendMessage(from, response);
      } else if (message.type === 'audio') {
        // CORRECCIÓN: Obtén el ID del audio del payload.
        const audioId = message.audio?.id;
        
        if (audioId) {
          const response = await this.whatsappService.manejarAudio(audioId);
          await this.whatsappService.sendMessage(from, response);
        } else {
          console.error('ID de audio no encontrado en el payload.');
          await this.whatsappService.sendMessage(from, "Lo siento, no pude procesar tu mensaje de audio. ¿Podrías escribir tu consulta, por favor?");
        }
      }
    }
  }
}