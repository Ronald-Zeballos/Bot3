import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as QRCode from 'qrcode';

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    'Authorization': `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  
  // Triggers para iniciar conversación
  private readonly TRIGGERS_BIENVENIDA = new RegExp(/(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches)/, 'i');
  
  // Triggers para consulta de productos
  private readonly TRIGGERS_PRODUCTOS = new RegExp(/(producto|comprar|precio|que tienen|qué tienen|oferta|menu|menú|catalogo|catálogo)/, 'i');
  
  // Almacenamiento simple de estados de usuario
  private userStates = new Map<string, { state: string, selectedProduct?: any }>();
  
  // Catálogo de productos
  private productos = [
    { id: 1, nombre: "Café Samaipata", precio: 45, descripcion: "Tueste medio con notas a chocolate y cítricos" },
    { id: 2, nombre: "Café Catavi", precio: 52, descripcion: "Notas a frutos rojos y tueste ligero" },
    { id: 3, nombre: "Café Americano", precio: 38, descripcion: "Blend clásico y balanceado" }
  ];

  private readonly geminiGenAI: GoogleGenerativeAI;
  private readonly geminiModel;

  constructor() {
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

  detectarTrigger(text: string, regex: RegExp): boolean {
    return regex.test(text.toLowerCase().trim());
  }

  async generarRespuesta(text: string, from: string): Promise<string> {
    const textLowerCase = text.toLowerCase().trim();
    const userState = this.userStates.get(from) || { state: 'initial' };

    // Lógica de estados
    if (userState.state === 'awaiting_product_selection') {
      return await this.handleProductSelection(text, from);
    } else if (userState.state === 'awaiting_payment') {
      return this.handlePaymentConfirmation(text, from);
    }

    // Lógica principal con if/else
    if (this.detectarTrigger(textLowerCase, this.TRIGGERS_BIENVENIDA)) {
      return "¡Hola! 👋 Bienvenido a nuestra tienda de café. ¿Te gustaría conocer nuestros productos?";
    } else if (this.detectarTrigger(textLowerCase, this.TRIGGERS_PRODUCTOS)) {
      await this.sendProductButtons(from);
      this.userStates.set(from, { state: 'awaiting_product_selection' });
      return "";
    } else if (textLowerCase.includes('samaipata')) {
      return "El café Samaipata es de tueste medio con notas a chocolate y cítricos. Precio: $45. ¿Te interesa comprarlo?";
    } else if (textLowerCase.includes('catavi')) {
      return "El café Catavi se caracteriza por sus notas a frutos rojos y un tueste ligero. Precio: $52. ¿Te interesa comprarlo?";
    } else if (textLowerCase.includes('americano')) {
      return "Nuestro café Americano es un blend de granos que ofrece un sabor clásico y balanceado. Precio: $38. ¿Te interesa comprarlo?";
    } else if (textLowerCase.includes('gracias') || textLowerCase.includes('gracias')) {
      return "¡Gracias a ti! ¿Hay algo más en lo que pueda ayudarte?";
    } else if (textLowerCase.includes('adiós') || textLowerCase.includes('chao') || textLowerCase.includes('hasta luego')) {
      return "¡Hasta luego! Espero verte pronto para disfrutar de nuestro café.";
    } else {
      // Solo usar IA para preguntas específicas sobre café, no para desviar la conversación
      if (this.esPreguntaSobreCafe(textLowerCase)) {
        return await this.generateGeminiResponse(text);
      } else {
        return "No estoy seguro de cómo responder a eso. ¿Te interesa conocer nuestros productos de café? Tenemos Samaipata, Catavi y Americano.";
      }
    }
  }

  private esPreguntaSobreCafe(text: string): boolean {
    const palabrasCafe = ['café', 'cafe', 'tueste', 'grano', 'arábica', 'robusta', 'preparación', 'molido'];
    return palabrasCafe.some(palabra => text.includes(palabra));
  }

  private async sendProductButtons(to: string) {
    const buttons = this.productos.map((producto) => ({
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
    // Verificar si el texto coincide con algún producto o su ID
    let selectedProduct = null;
    for (const producto of this.productos) {
      if (text.toLowerCase().includes(producto.nombre.toLowerCase()) || text.includes(producto.id.toString())) {
        selectedProduct = producto;
        break;
      }
    }

    if (selectedProduct) {
      this.userStates.set(from, { 
        state: 'awaiting_payment', 
        selectedProduct 
      });

      // Generar QR code (en base64)
      const qrData = await this.generateQRCode(selectedProduct.precio, from);
      
      // Enviar imagen con QR (usamos un servidor temporal para la imagen base64)
      const qrImageUrl = await this.uploadQRImage(qrData);

      await this.sendImage(
        from, 
        qrImageUrl, 
        `✅ *${selectedProduct.nombre} seleccionado*\n\nPrecio: $${selectedProduct.precio}\n\nEscanea el QR code para completar tu pago.`
      );

      return "¡Perfecto! He enviado un QR code para que completes tu pago. ¿Necesitas algo más?";
    } else {
      await this.sendProductButtons(from);
      return "No reconocí esa opción. Por favor selecciona uno de nuestros productos:";
    }
  }

  private async generateQRCode(monto: number, referencia: string): Promise<string> {
    // Datos para el QR
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
      throw new Error('No se pudo generar el QR');
    }
  }

  private async uploadQRImage(dataUrl: string): Promise<string> {
    // En un entorno real, subirías la imagen a un servidor o usarías un servicio de almacenamiento
    console.log('Simulando subida de imagen QR...');
    return 'https://example.com/qr.png'; // URL simulada
  }

  private handlePaymentConfirmation(text: string, from: string): string {
    // Lógica para confirmar pago (simulada)
    this.userStates.set(from, { state: 'initial' });
    return "¡Gracias por tu compra! Tu pedido está siendo procesado. Te avisaremos cuando esté listo.";
  }

  // Método para obtener el texto del botón por ID
  getButtonTextById(buttonId: string): string {
    const match = buttonId.match(/product_(\d+)/);
    if (match) {
      const productId = parseInt(match[1]);
      const product = this.productos.find(p => p.id === productId);
      return product ? product.nombre : buttonId;
    }
    return buttonId;
  }

  private async generateGeminiResponse(userText: string): Promise<string> {
    try {
      const prompt = `Eres un experto en café que trabaja en una tienda. Responde únicamente preguntas específicas sobre café.
      Mantén tus respuestas breves y centradas en la pregunta.
      Si la pregunta no está relacionada con café, di amablemente: "Solo puedo responder preguntas sobre café. ¿Te interesa conocer nuestros productos?".
      
      Pregunta: ${userText}`;

      const result = await this.geminiModel.generateContent(prompt);
      const response = result.response;
      let responseText = response.text();

      // Limpiar la respuesta de la IA
      responseText = responseText.replace(/\*/g, '');

      return responseText;
    } catch (error) {
      console.error('Error al generar respuesta con Gemini:', error);
      return "Lo siento, tengo problemas para entenderte en este momento. ¿Te interesa conocer nuestros productos?";
    }
  }
}