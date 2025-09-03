import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { AssemblyaiService } from '../assemblyai/assemblyai.service';

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    'Authorization': `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  private readonly OBJETIVO_VENTA = process.env.OBJETIVO_VENTA;
  private readonly TRIGGERS_BIENVENIDA = new RegExp(`^(${process.env.TRIGGERS_BIENVENIDA})$`, 'i');

  constructor(private readonly assemblyaiService: AssemblyaiService) {}

  async sendMessage(to: string, message: string) {
    const body = {
      messaging_product: 'whatsapp',
      to: to,
      text: { body: message },
    };
    await axios.post(this.API_URL, body, { headers: this.HEADERS });
  }

  detectarTrigger(text: string): boolean {
    return this.TRIGGERS_BIENVENIDA.test(text.toLowerCase().trim());
  }

  generarRespuesta(text: string): string {
    if (this.detectarTrigger(text)) {
      return "¡Hola! 👋 Bienvenido. Soy tu asistente personal. ¿En qué puedo ayudarte hoy?";
    } else {
      return `Gracias por tu mensaje. Para más información sobre nuestro producto, te invito a conocer más sobre nuestra ${this.OBJETIVO_VENTA}. ¡Te va a encantar!`;
    }
  }

  async manejarAudio(audioUrl: string): Promise<string> {
    try {
      console.log(`URL de audio a transcribir: ${audioUrl}`);
      const transcribedText = await this.assemblyaiService.transcribeAudio(audioUrl);
      return `He transcrito tu audio: "${transcribedText}". ¿Puedo guiarte hacia la ${this.OBJETIVO_VENTA}?`;
    } catch (error) {
      console.error('Error al manejar el audio:', error);
      return "Lo siento, no pude procesar tu mensaje de audio. ¿Podrías escribir tu consulta, por favor?";
    }
  }
}