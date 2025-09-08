// src/whatsapp/whatsapp.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    'Authorization': `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  private readonly TRIGGERS_BIENVENIDA = new RegExp(`^(${process.env.TRIGGERS_BIENVENIDA})$`, 'i');
  
  // Productos y sus precios
  private readonly products = [
    { id: '1', title: 'Café Samaipata', price: 25.50 },
    { id: '2', title: 'Café Catavi', price: 22.00 },
    { id: '3', title: 'Café Americano', price: 18.00 },
    { id: '4', title: 'Café con Leche', price: 20.00 },
    { id: '5', title: 'Espresso', price: 15.00 },
  ];

  // Toppings y sus precios
  private readonly toppings = [
    { id: 't1', title: 'Galletas de Canela', price: 5.00 },
    { id: 't2', title: 'Sirope de Caramelo', price: 3.50 },
    { id: 't3', title: 'Crema Batida', price: 4.00 },
  ];

  private readonly geminiGenAI: GoogleGenerativeAI;
  private readonly geminiModel;

  // CORRECTION: The constructor no longer needs to inject AssemblyaiService
  constructor() {
    this.geminiGenAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.geminiModel = this.geminiGenAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  }

  async sendMessage(to: string, payload: any) {
    const body = {
      messaging_product: 'whatsapp',
      to: to,
      ...payload,
    };
    try {
      await axios.post(this.API_URL, body, { headers: this.HEADERS });
    } catch (error) {
      console.error('Error al enviar mensaje:', error.response ? error.response.data : error.message);
    }
  }

  detectarTrigger(text: string): boolean {
    return this.TRIGGERS_BIENVENIDA.test(text.toLowerCase().trim());
  }

  async generarRespuesta(text: string): Promise<string> {
    const textLowerCase = text.toLowerCase().trim();

    if (this.detectarTrigger(textLowerCase)) {
      return "¡Hola! 👋 Bienvenido. Soy tu asistente personal. ¿En qué puedo ayudarte hoy?";
    } else if (textLowerCase.includes('samaipata')) {
      return "El café Samaipata es de tueste medio con notas a chocolate y cítricos. ¡Es uno de los favoritos!";
    } else if (textLowerCase.includes('catavi')) {
      return "El café Catavi se caracteriza por sus notas a frutos rojos y un tueste ligero, ideal para métodos de filtrado.";
    } else if (textLowerCase.includes('americano')) {
      return "Nuestro café Americano es un blend de granos que ofrece un sabor clásico y balanceado.";
    } else {
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
      responseText = responseText.replace(/\*/g, '');
      return responseText;
    } catch (error) {
      console.error('Error al generar respuesta con Gemini:', error);
      return "Lo siento, tengo problemas para entenderte en este momento. Por favor, intenta de nuevo.";
    }
  }

  // --- Métodos de flujo de ventas ---
  
  async sendProductList(to: string) {
    const sections = [{
      title: "Nuestros Cafés",
      rows: this.products.map(p => ({
        id: p.id,
        title: p.title,
        description: `Bs. ${p.price.toFixed(2)}`,
      })),
    }];

    const payload = {
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "Selecciona tu café favorito",
        },
        body: {
          text: "¿Qué producto deseas el día de hoy?",
        },
        footer: {
          text: "¡Disfruta de tu café!"
        },
        action: {
          button: "Ver opciones",
          sections: sections,
        },
      },
    };
    await this.sendMessage(to, payload);
  }

  async handleProductSelection(to: string, selectedId: string) {
    const product = this.products.find(p => p.id === selectedId);
    if (product) {
      await this.sendMessage(to, { text: { body: `Perfecto, el precio de tu ${product.title} será de Bs. ${product.price.toFixed(2)}. ¿Deseas algún topping o agregado?` } });
      await this.sendToppingOptions(to);
    } else {
      await this.sendMessage(to, { text: { body: "Producto no encontrado. Por favor, selecciona una opción de la lista." } });
    }
  }

  async sendToppingOptions(to: string) {
    const buttons = this.toppings.map(t => ({
      type: "reply",
      reply: {
        id: t.id,
        title: `${t.title} (Bs. ${t.price.toFixed(2)})`,
      },
    }));

    const payload = {
      interactive: {
        type: "button",
        body: {
          text: "¿Qué deseas agregar?",
        },
        action: {
          buttons: buttons,
        },
      },
    };
    await this.sendMessage(to, payload);
  }

  async handleToppingSelection(to: string, selectedId: string) {
    const topping = this.toppings.find(t => t.id === selectedId);
    if (topping) {
      await this.sendMessage(to, { text: { body: `¡Excelente! Has agregado ${topping.title} por Bs. ${topping.price.toFixed(2)}.` } });
    } else {
      await this.sendMessage(to, { text: { body: "Opción no válida. Intenta de nuevo." } });
    }
  }
}