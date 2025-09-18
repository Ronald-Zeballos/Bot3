import { Controller, Post, Get, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('webhook')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // Verificación del webhook (GET)
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') token: string,
  ): string {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ Webhook verificado con éxito');
      return challenge;
    }
    console.warn('❌ Token de verificación incorrecto.');
    return 'Token de verificación incorrecto.';
  }

  // Recepción de mensajes (POST)
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() body: any) {
    try {
      const entries = body?.entry || [];
      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change?.value;
          const messages = value?.messages || [];
          if (!messages.length) continue;

          for (const message of messages) {
            const from = message?.from;
            if (!from) continue;

            // 1) Mensajes de texto
            if (message.type === 'text') {
              const userText = message.text?.body || '';
              console.log(`💬 Texto de ${from}: ${userText}`);
              const response = await this.whatsappService.generarRespuesta(userText, from);
              if (response && response.trim() !== '') {
                await this.whatsappService.sendMessage(from, response);
              }
              continue;
            }

            // 2) Interactivos (botones o listas)
            if (message.type === 'interactive') {
              const itype = message.interactive?.type;

              if (itype === 'button_reply') {
                const buttonId = message.interactive?.button_reply?.id;
                const buttonTitle = message.interactive?.button_reply?.title; // opcional
                console.log(`🖲️ Button reply de ${from}: id=${buttonId} title=${buttonTitle}`);

                const response = await this.whatsappService.generarRespuesta('', from, buttonId);
                if (response && response.trim() !== '') {
                  await this.whatsappService.sendMessage(from, response);
                }
                continue;
              }

              if (itype === 'list_reply') {
                const listId = message.interactive?.list_reply?.id;
                const listTitle = message.interactive?.list_reply?.title; // opcional
                console.log(`📋 List reply de ${from}: id=${listId} title=${listTitle}`);

                const response = await this.whatsappService.generarRespuesta('', from, listId);
                if (response && response.trim() !== '') {
                  await this.whatsappService.sendMessage(from, response);
                }
                continue;
              }
            }

            // 3) Otros tipos (audio, imagen, etc.)
            console.log(`ℹ️ Tipo no manejado: ${message.type}`);
            const fallback = 'Puedo ayudarte a *agendar una cita*. Escribe "hola" para comenzar.';
            await this.whatsappService.sendMessage(from, fallback);
          }
        }
      }

      return { status: 'ok' };
    } catch (error: any) {
      console.error('Error en handleWebhook:', error?.response?.data || error?.message || error);
      return { status: 'error', message: error?.message || 'unknown' };
    }
  }
}