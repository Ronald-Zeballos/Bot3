// src/whatsapp/whatsapp.controller.ts
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

            // 1) Texto
            if (message.type === 'text') {
              const userText = message.text?.body || '';
              console.log(`💬 Texto de ${from}: ${userText}`);
              const response = await this.whatsappService.generarRespuesta(userText, from);
              if (response && response.trim() !== '') {
                await this.whatsappService.sendMessage(from, response);
              }
              continue;
            }

            // 2) Interactivos (botones / listas)
            if (message.type === 'interactive') {
              const itype = message.interactive?.type;

              if (itype === 'button_reply') {
                const buttonId = message.interactive?.button_reply?.id;
                console.log(`🖲️ Button reply de ${from}: id=${buttonId}`);
                const response = await this.whatsappService.generarRespuesta('', from, buttonId);
                if (response && response.trim() !== '') {
                  await this.whatsappService.sendMessage(from, response);
                }
                continue;
              }

              if (itype === 'list_reply') {
                const listId = message.interactive?.list_reply?.id;
                console.log(`📋 List reply de ${from}: id=${listId}`);
                const response = await this.whatsappService.generarRespuesta('', from, listId);
                if (response && response.trim() !== '') {
                  await this.whatsappService.sendMessage(from, response);
                }
                continue;
              }
            }

            // 3) Audio (opcional, si aún no lo usas no pasa nada)
            if (message.type === 'audio') {
              const mediaId = message.audio?.id;
              console.log(`🎤 Audio de ${from}: mediaId=${mediaId}`);
              const response = await this.whatsappService.handleIncomingAudio?.(from, mediaId);
              if (response && response.trim() !== '') {
                await this.whatsappService.sendMessage(from, response);
              }
              continue;
            }

            // 4) Otros tipos
            console.log(`ℹ️ Tipo no manejado: ${message.type}`);
            await this.whatsappService.sendMessage(
              from,
              'Puedo ayudarte desde el *menú*. Escribe "hola" para comenzar.'
            );
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
