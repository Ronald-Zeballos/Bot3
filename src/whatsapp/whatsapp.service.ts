import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { google } from 'googleapis';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleAuth } from 'google-auth-library'; // Importación añadida

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    'Authorization': `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  
  // Triggers para servicios
  private readonly TRIGGERS_TRIBUTARIO = new RegExp(/(impuestos|tributario|tributaria|fiscal|sat)/, 'i');
  private readonly TRIGGERS_LEGAL = new RegExp(/(legal|contrato|ley|abogado|jurídico)/, 'i');
  private readonly TRIGGERS_LABORAL = new RegExp(/(laboral|empleo|trabajo|contratación|despido)/, 'i');
  private readonly TRIGGERS_CONTABILIDAD = new RegExp(/(contabilidad|contable|libros contables|declaraciones|facturación)/, 'i');
  private readonly TRIGGERS_SISTEMAS = new RegExp(/(sistemas|software|redes|computadoras|informática|tecnología)/, 'i');
  
  // Almacenamiento de estados de usuario
  private userStates = new Map<string, { 
    state: string, 
    serviceType?: string, 
    appointmentDate?: string,
    appointmentTime?: string,
    clientData?: any 
  }>();
  
  // Calendario y APIs de Google
  private calendar: any;
  private sheets: any;
  private readonly CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
  private readonly SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

  private readonly geminiGenAI: GoogleGenerativeAI;
  private readonly geminiModel;

  constructor() {
    this.geminiGenAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.geminiModel = this.geminiGenAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    // Configurar autenticación de Google
    this.setupGoogleAuth();
  }

private async setupGoogleAuth() {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    
    // Solución alternativa: crear auth directamente con google.auth.fromJSON
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      },
      scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets'],
    });

    const authClient = await auth.getClient();

    // Usar 'as any' para evitar conflictos de tipos
    this.calendar = google.calendar({ version: 'v3', auth: authClient as any });
    this.sheets = google.sheets({ version: 'v4', auth: authClient as any });
    
    console.log('Autenticación con Google API configurada correctamente');
  } catch (error) {
    console.error('Error configurando autenticación de Google:', error);
  }
}

  async sendMessage(to: string, message: string) {
    try {
      const body = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { 
          preview_url: false,
          body: message 
        },
      };
      
      console.log('Enviando mensaje:', JSON.stringify(body, null, 2));
      
      const response = await axios.post(this.API_URL, body, { 
        headers: this.HEADERS 
      });
      
      console.log('Mensaje enviado con éxito:', response.data);
      return response.data;
    } catch (error) {
      console.error('Error al enviar mensaje:', error.response?.data || error.message);
      throw new Error('No se pudo enviar el mensaje: ' + (error.response?.data?.error?.message || error.message));
    }
  }

  async sendButtons(to: string, message: string, buttons: any[]) {
    try {
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
      
      console.log('Enviando botones:', JSON.stringify(body, null, 2));
      
      const response = await axios.post(this.API_URL, body, { 
        headers: this.HEADERS 
      });
      
      console.log('Botones enviados con éxito:', response.data);
      return response.data;
    } catch (error) {
      console.error('Error al enviar botones:', error.response?.data || error.message);
      throw new Error('No se pudieron enviar los botones: ' + (error.response?.data?.error?.message || error.message));
    }
  }

  async sendImage(to: string, imageUrl: string, caption: string) {
    try {
      const body = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption
        }
      };
      
      console.log('Enviando imagen:', JSON.stringify(body, null, 2));
      
      const response = await axios.post(this.API_URL, body, { 
        headers: this.HEADERS 
      });
      
      console.log('Imagen enviada con éxito:', response.data);
      return response.data;
    } catch (error) {
      console.error('Error al enviar imagen:', error.response?.data || error.message);
      
      // Fallback: enviar mensaje de texto con la URL
      const fallbackMessage = `${caption}\n\nSi no puedes ver la imagen, visita este enlace: ${imageUrl}`;
      return this.sendMessage(to, fallbackMessage);
    }
  }

  detectarTrigger(text: string, regex: RegExp): boolean {
    return regex.test(text.toLowerCase().trim());
  }

  async generarRespuesta(text: string, from: string): Promise<string> {
    const textLowerCase = text.toLowerCase().trim();
    const userState = this.userStates.get(from) || { state: 'initial' };

    // Lógica de estados
    if (userState.state === 'awaiting_service_type') {
      return await this.handleServiceSelection(text, from);
    } else if (userState.state === 'awaiting_appointment_confirmation') {
      return await this.handleAppointmentConfirmation(text, from);
    } else if (userState.state === 'awaiting_contact_info') {
      return await this.handleContactInfo(text, from);
    } else if (userState.state === 'awaiting_name') {
      return await this.handleNameInput(text, from);
    } else if (userState.state === 'awaiting_phone') {
      return await this.handlePhoneInput(text, from);
    } else if (userState.state === 'awaiting_email') {
      return await this.handleEmailInput(text, from);
    }

    // Lógica principal con if/else
    if (this.detectarTrigger(textLowerCase, new RegExp(/(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches|inicio|empezar)/, 'i'))) {
      await this.sendWelcomeButtons(from);
      return "";
    } else if (textLowerCase.includes('gracias') || textLowerCase.includes('thank you')) {
      return "¡Gracias a ti! ¿Hay algo más en lo que pueda ayudarte?";
    } else if (textLowerCase.includes('adiós') || textLowerCase.includes('chao') || textLowerCase.includes('hasta luego')) {
      return "¡Hasta luego! Espero verte pronto. No dudes en contactarnos si necesitas más información.";
    } else {
      return "No estoy seguro de cómo responder a eso. ¿Te interesa conocer nuestros servicios? Escribe 'hola' para comenzar.";
    }
  }

  private async sendWelcomeButtons(to: string) {
    const buttons = [
      {
        type: "reply",
        reply: {
          id: "servicios",
          title: "Ver servicios"
        }
      },
      {
        type: "reply",
        reply: {
          id: "agendar_cita",
          title: "Agendar cita"
        }
      }
    ];

    const message = "¡Hola! 👋 Bienvenido a nuestros servicios profesionales. ¿En qué puedo ayudarte hoy?\n\n" +
      "Puedes seleccionar una opción o escribir directamente qué servicio necesitas:\n" +
      "- Asesoría tributaria, legal o laboral\n" +
      "- Contabilidad tercerizada\n" +
      "- Revisión de sistemas informáticos\n" +
      "- Otros servicios";

    this.userStates.set(to, { state: 'awaiting_service_type' });
    await this.sendButtons(to, message, buttons);
  }

  private async handleServiceSelection(text: string, from: string): Promise<string> {
    const textLowerCase = text.toLowerCase().trim();
    let serviceType = '';
    
    if (this.detectarTrigger(textLowerCase, this.TRIGGERS_TRIBUTARIO) || 
        this.detectarTrigger(textLowerCase, this.TRIGGERS_LEGAL) || 
        this.detectarTrigger(textLowerCase, this.TRIGGERS_LABORAL)) {
      serviceType = 'Asesoría tributaria, legal y laboral';
    } else if (this.detectarTrigger(textLowerCase, this.TRIGGERS_CONTABILIDAD)) {
      serviceType = 'Contabilidad tercerizada';
    } else if (this.detectarTrigger(textLowerCase, this.TRIGGERS_SISTEMAS)) {
      serviceType = 'Revisión de sistemas informáticos';
    } else {
      serviceType = 'Otros servicios o consultas generales';
    }

    // Actualizar estado del usuario
    const userState = this.userStates.get(from) || { state: 'awaiting_service_type' };
    userState.serviceType = serviceType;
    userState.state = 'awaiting_appointment_confirmation';
    this.userStates.set(from, userState);

    // Redirigir al número especificado
    const redirectMessage = `He identificado que necesitas: ${serviceType}. \n\nSerás contactado por nuestro especialista en breve al número +591 65900645. \n\n¿Te gustaría agendar una cita ahora?`;
    
    const buttons = [
      {
        type: "reply",
        reply: {
          id: "agendar_si",
          title: "Sí, agendar cita"
        }
      },
      {
        type: "reply",
        reply: {
          id: "agendar_no",
          title: "No, gracias"
        }
      }
    ];

    await this.sendButtons(from, redirectMessage, buttons);
    return "";
  }

  private async handleAppointmentConfirmation(text: string, from: string): Promise<string> {
    const textLowerCase = text.toLowerCase().trim();
    
    if (textLowerCase.includes('si') || textLowerCase.includes('sí') || textLowerCase.includes('agendar_si')) {
      // Mostrar disponibilidad de citas
      const availableSlots = await this.getAvailableAppointmentSlots();
      
      if (availableSlots.length === 0) {
        return "Lo siento, no hay horarios disponibles en este momento. Por favor, intenta más tarde o contacta directamente al +591 65900645.";
      }
      
      let message = "Estos son los horarios disponibles:\n\n";
      availableSlots.forEach((slot, index) => {
        message += `${index + 1}. ${slot.date} a las ${slot.time}\n`;
      });
      
      message += "\nPor favor, responde con el número de la opción que prefieres.";
      
      this.userStates.set(from, { 
        ...this.userStates.get(from),
        state: 'awaiting_contact_info'
      });
      
      return message;
    } else {
      this.userStates.set(from, { state: 'initial' });
      return "De acuerdo. Serás contactado pronto por nuestro especialista. ¡Gracias!";
    }
  }

  private async getAvailableAppointmentSlots(): Promise<{date: string, time: string}[]> {
    try {
      // Obtener horarios disponibles del calendario
      const now = new Date();
      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      
      const response = await this.calendar.events.list({
        calendarId: this.CALENDAR_ID,
        timeMin: now.toISOString(),
        timeMax: nextWeek.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      
      const events = response.data.items || [];
      
      // Generar horarios disponibles (simulado por ahora)
      // En una implementación real, se calcularían los huecos entre eventos
      const availableSlots = [
        { date: '2025-10-15', time: '09:00' },
        { date: '2025-10-15', time: '11:00' },
        { date: '2025-10-16', time: '10:00' },
        { date: '2025-10-16', time: '14:00' },
        { date: '2025-10-17', time: '09:30' },
        { date: '2025-10-17', time: '15:00' },
      ];
      
      return availableSlots;
    } catch (error) {
      console.error('Error obteniendo horarios disponibles:', error);
      return [];
    }
  }

  private async handleContactInfo(text: string, from: string): Promise<string> {
    // Aquí se procesaría la selección de horario
    // Por simplicidad, asumimos que el usuario seleccionó un horario válido
    
    this.userStates.set(from, { 
      ...this.userStates.get(from),
      state: 'awaiting_name',
      appointmentDate: '2025-10-15', // Fecha ejemplo
      appointmentTime: '09:00' // Hora ejemplo
    });
    
    return "Perfecto. Para agendar tu cita, necesito algunos datos:\n\nPor favor, escribe tu nombre completo.";
  }

  private async handleNameInput(text: string, from: string): Promise<string> {
    const userState = this.userStates.get(from);
    userState.clientData = { nombre: text };
    userState.state = 'awaiting_phone';
    this.userStates.set(from, userState);
    
    return "Gracias. Ahora por favor escribe tu número de teléfono.";
  }

  private async handlePhoneInput(text: string, from: string): Promise<string> {
    const userState = this.userStates.get(from);
    userState.clientData.telefono = text;
    userState.state = 'awaiting_email';
    this.userStates.set(from, userState);
    
    return "Ahora por favor escribe tu correo electrónico.";
  }

  private async handleEmailInput(text: string, from: string): Promise<string> {
    const userState = this.userStates.get(from);
    userState.clientData.email = text;
    userState.state = 'initial';
    this.userStates.set(from, userState);
    
    // Guardar datos en Google Sheets
    await this.saveClientData(userState);
    
    // Generar PDF de confirmación
    const pdfUrl = await this.generateConfirmationPDF(userState);
    
    // Enviar confirmación
    await this.sendMessage(from, `¡Perfecto! Tu cita ha sido agendada para el ${userState.appointmentDate} a las ${userState.appointmentTime}.\n\nPronto recibirás una confirmación por correo.`);
    
    // Enviar PDF si se generó correctamente
    if (pdfUrl) {
      await this.sendImage(from, pdfUrl, "Aquí tienes tu comprobante de cita.");
    }
    
    return "¿Necesitas algo más?";
  }

  private async saveClientData(userState: any): Promise<boolean> {
    try {
      const values = [
        [
          userState.clientData.nombre,
          userState.clientData.telefono,
          userState.clientData.email,
          userState.serviceType,
          userState.appointmentDate,
          userState.appointmentTime,
          new Date().toISOString()
        ]
      ];
      
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.SPREADSHEET_ID,
        range: 'A1',
        valueInputOption: 'RAW',
        requestBody: {
          values: values
        }
      });
      
      console.log('Datos guardados en Google Sheets:', response.data);
      return true;
    } catch (error) {
      console.error('Error guardando datos en Google Sheets:', error);
      return false;
    }
  }

  private async generateConfirmationPDF(userState: any): Promise<string> {
    try {
      const doc = new PDFDocument();
      const fileName = `cita_${userState.clientData.nombre.replace(/\s+/g, '_')}_${Date.now()}.pdf`;
      const filePath = path.join(__dirname, '..', 'tmp', fileName);
      
      // Asegurarse de que el directorio existe
      if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }
      
      // Guardar PDF localmente
      doc.pipe(fs.createWriteStream(filePath));
      
      // Contenido del PDF
      doc.fontSize(20).text('Confirmación de Cita', 100, 100);
      doc.fontSize(12).text(`Nombre: ${userState.clientData.nombre}`, 100, 150);
      doc.text(`Teléfono: ${userState.clientData.telefono}`, 100, 170);
      doc.text(`Email: ${userState.clientData.email}`, 100, 190);
      doc.text(`Servicio: ${userState.serviceType}`, 100, 210);
      doc.text(`Fecha: ${userState.appointmentDate}`, 100, 230);
      doc.text(`Hora: ${userState.appointmentTime}`, 100, 250);
      
      doc.end();
      
      // En una implementación real, aquí subirías el PDF a un servicio de almacenamiento
      // y devolverías la URL pública. Por ahora, devolvemos una URL de ejemplo.
      return `https://ejemplo.com/pdfs/${fileName}`;
    } catch (error) {
      console.error('Error generando PDF:', error);
      return null;
    }
  }

  // Método para obtener el texto del botón por ID
  getButtonTextById(buttonId: string): string {
    if (buttonId === 'servicios') {
      return 'Ver servicios';
    } else if (buttonId === 'agendar_cita') {
      return 'Agendar cita';
    } else if (buttonId === 'agendar_si') {
      return 'Sí, agendar cita';
    } else if (buttonId === 'agendar_no') {
      return 'No, gracias';
    }
    
    return buttonId;
  }
}