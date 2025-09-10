import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { AssemblyaiService } from '../assemblyai/assemblyai.service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as QRCode from 'qrcode';

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    'Authorization': `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  private readonly TRIGGERS_BIENVENIDA = new RegExp(`^(${process.env.TRIGGERS_BIENVENIDA})$`, 'i');
  
  // Almacenamiento simple de estados de usuario (en producción usarías una base de datos)
  private userStates = new Map<string, { state: string, selectedProduct?: any }>();
  
  // Catálogo de productos
  private productos = [
    { id: 1, nombre: "Café Samaipata", precio: 45, descripcion: "Tueste medio con notas a chocolate y cítricos" },
    { id: 2, nombre: "Café Catavi", precio: 52, descripcion: "Notas a frutos rojos y tueste ligero" },
    { id: 3, nombre: "Café Americano", precio: 38, descripcion: "Blend clásico y balanceado" }
  ];

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

  async sendButtons(to: string, message: string, buttons: any[]) {
    const body = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: message
        },
        action: {
          buttons: buttons
        }
      }
    };
    await axios.post(this.API_URL, body, { headers: this.HEADERS });
  }

  async sendImage(to: string, imageUrl: string, caption: string) {
    const body = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption
      }
    };
    await axios.post(this.API_URL, body, { headers: this.HEADERS });
  }

  detectarTrigger(text: string): boolean {
    return this.TRIGGERS_BIENVENIDA.test(text.toLowerCase().trim());
  }

  async generarRespuesta(text: string, from: string): Promise<string> {
    const textLowerCase = text.toLowerCase().trim();
    const userState = this.userStates.get(from) || { state: 'initial' };

    // Lógica de estados
    if (userState.state === 'awaiting_product_selection') {
      return this.handleProductSelection(text, from);
    } else if (userState.state === 'awaiting_payment') {
      return this.handlePaymentConfirmation(text, from);
    }

    // Lógica de respuestas predefinidas (triggers)
    if (this.detectarTrigger(textLowerCase)) {
      await this.sendProductButtons(from);
      this.userStates.set(from, { state: 'awaiting_product_selection' });
      return ""; // Mensaje vacío porque ya enviamos los botones
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

  private async sendProductButtons(to: string) {
    const buttons = this.productos.map((producto, index) => ({
      type: "reply",
      reply: {
        id: `product_${producto.id}`,
        title: `${producto.nombre} - $${producto.precio}`
      }
    }));

    const message = "¡Excelente! Tenemos estas opciones disponibles:\n\n" +
      this.productos.map(p => `*${p.nombre}* - $${p.precio}\n${p.descripcion}`).join('\n\n') +
      "\n\nPor favor, selecciona una opción:";

    await this.sendButtons(to, message, buttons);
  }

  private async handleProductSelection(text: string, from: string): Promise<string> {
    const selectedProduct = this.productos.find(p => 
      text.toLowerCase().includes(p.nombre.toLowerCase()) || 
      text.includes(p.id.toString())
    );

    if (selectedProduct) {
      this.userStates.set(from, { 
        state: 'awaiting_payment', 
        selectedProduct 
      });

      // Generar QR code
      const qrData = await this.generateQRCode(selectedProduct.precio, from);
      
      // Enviar imagen con QR
      await this.sendImage(
        from, 
        qrData, 
        `✅ *${selectedProduct.nombre} seleccionado*\n\nPrecio: $${selectedProduct.precio}\n\nEscanea el QR code para completar tu pago.`
      );

      return "¡Perfecto! He enviado un QR code para que completes tu pago. ¿Necesitas algo más?";
    } else {
      await this.sendProductButtons(from);
      return "No reconocí esa opción. Por favor selecciona uno de nuestros productos:";
    }
  }

  private async generateQRCode(monto: number, referencia: string): Promise<string> {
    // Datos para el QR (aquí personaliza con tu información de pago)
    const paymentData = {
      merchant: "Tu Cafetería",
      account: "1234567890",
      amount: monto,
      currency: "BOB",
      reference: referencia
    };

    const qrString = JSON.stringify(paymentData);
    
    try {
      // Generar QR como Data URL
      return await QRCode.toDataURL(qrString);
    } catch (err) {
      console.error('Error generando QR:', err);
      // Fallback a una imagen estática o mensaje de error
      return 'https://ejemplo.com/qr-fallback.png';
    }
  }

  private handlePaymentConfirmation(text: string, from: string): string {
    // Lógica para confirmar pago (simulada)
    this.userStates.set(from, { state: 'initial' });
    return "¡Gracias por tu compra! Tu pedido está siendo procesado. Te avisaremos cuando esté listo.";
  }

  // ... (el resto de tus métodos existentes como generateGeminiResponse, getAudioUrl, manejarAudio)


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


}