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
        const response = this.whatsappService.generarRespuesta(userText);
        await this.whatsappService.sendMessage(from, response);
      } else if (message.type === 'audio') {
        // Nota: La URL del audio en el webhook es un ID.
        // Necesitarás hacer una solicitud GET a la API de Meta para obtener la URL real del archivo.
        // Para fines de este ejemplo, asumiremos que la URL del audio está directamente en el payload
        // En una aplicación real, usarías message.audio.id y harías una solicitud a
        // https://graph.facebook.com/v19.0/${audioId}/

        const audioUrl = changes.value.media_url; 
        const response = await this.whatsappService.manejarAudio(audioUrl);
        await this.whatsappService.sendMessage(from, response);
      }
    }
  }
}