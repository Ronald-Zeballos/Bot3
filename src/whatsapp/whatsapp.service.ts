import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { AssemblyaiService } from '../assemblyai/assemblyai.service';
import { GoogleGenerativeAI } from '@google/generative-ai';

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    'Authorization': `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  private readonly OBJETIVO_VENTA = process.env.OBJETIVO_VENTA;
  private readonly TRIGGERS_BIENVENIDA = new RegExp(`^(${process.env.TRIGGERS_BIENVENIDA})$`, 'i');
  
  private readonly geminiGenAI: GoogleGenerativeAI;
  private readonly geminiModel;

  constructor(private readonly assemblyaiService: AssemblyaiService) {
    this.geminiGenAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.geminiModel = this.geminiGenAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  }

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

  async generarRespuesta(text: string): Promise<string> {
    const textLowerCase = text.toLowerCase().trim();

    // Lógica de respuestas predefinidas (triggers)
    if (this.detectarTrigger(textLowerCase)) {
      return "¡Hola! 👋 Bienvenido. Soy tu asistente personal. ¿En qué puedo ayudarte hoy?";
    } else if (textLowerCase.includes('samaipata')) {
      return "El café Samaipata es de tueste medio con notas a chocolate y cítricos. ¡Es uno de los favoritos!";
    } else if (textLowerCase.includes('catavi')) {
      return "El café Catavi se caracteriza por sus notas a frutos rojos y un tueste ligero, ideal para métodos de filtrado.";
    } else if (textLowerCase.includes('americano')) {
      return "Nuestro café Americano es un blend de granos que ofrece un sabor clásico y balanceado.";
    } else {
      // Lógica de IA como fallback
      return await this.generateGeminiResponse(text);
    }
  }

  private async generateGeminiResponse(userText: string): Promise<string> {
    try {
      const prompt = `Eres un chatbot que vende café de especialidad.
      Debes ser amigable y responder preguntas sobre café, granos (como Bourbon o Geisha), métodos de preparación, etc.
      Si el usuario pregunta algo que no tiene que ver con café, redirígelo amablemente a la venta de café.
      Ejemplo de redirección: "No tengo la hora, pero puedo ofrecerte un delicioso café Samaipata."
      Usuario: ${userText}`;

      const result = await this.geminiModel.generateContent(prompt);
      const response = result.response;
      let responseText = response.text();

      // Limpiar la respuesta de la IA (opcional)
      responseText = responseText.replace(/\*/g, '');

      return responseText;
    } catch (error) {
      console.error('Error al generar respuesta con Gemini:', error);
      return "Lo siento, tengo problemas para entenderte en este momento. Por favor, intenta de nuevo.";
    }
  }
  
  async getAudioUrl(audioId: string): Promise<string> {
    const url = `https://graph.facebook.com/v22.0/${audioId}`;
    const headers = {
      'Authorization': `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    };
    try {
      const response = await axios.get(url, { headers });
      return response.data.url;
    } catch (error) {
      console.error('Error al obtener la URL del audio de Meta:', error.response ? error.response.data : error.message);
      throw new Error('No se pudo obtener la URL del audio.');
    }
  }

  async manejarAudio(audioId: string): Promise<string> {
    try {
      // 1. Obtener la URL real del audio de la API de Meta
      const audioUrl = await this.getAudioUrl(audioId);
      console.log(`URL de audio a transcribir: ${audioUrl}`);

      // 2. Transcribir el audio con AssemblyAI
      const transcribedText = await this.assemblyaiService.transcribeAudio(audioUrl);
      
      // 3. Pasar el texto transcrito a la lógica de respuesta mixta
      return await this.generarRespuesta(transcribedText);

    } catch (error) {
      console.error('Error al manejar el audio:', error);
      return "Lo siento, no pude procesar tu mensaje de audio. ¿Podrías escribir tu consulta, por favor?";
    }
  }
}