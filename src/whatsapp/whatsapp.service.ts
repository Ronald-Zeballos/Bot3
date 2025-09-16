// src/whatsapp.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { google } from 'googleapis';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import QRCode from 'qrcode';

type ClientData = { 
  nombre?: string; 
  telefono?: string; 
  email?: string;
  servicio?: string;
  fecha?: string;
  hora?: string;
};

type SlotOffered = { row: number; date: string; time: string; label: string };

type UserState = {
  state: string;
  serviceType?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  clientData?: ClientData;
  lastOfferedSlots?: SlotOffered[];
  updatedAt?: number;
  currentStep?: number;
  totalSteps?: number;
};

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Triggers por dominio
  private readonly TRIGGERS_TRIBUTARIO = new RegExp(/(impuestos|tributario|tributaria|fiscal|sat)/, 'i');
  private readonly TRIGGERS_LEGAL = new RegExp(/(legal|contrato|ley|abogado|jur[ií]dico)/, 'i');
  private readonly TRIGGERS_LABORAL = new RegExp(/(laboral|empleo|trabajo|contrataci[oó]n|despido)/, 'i');
  private readonly TRIGGERS_CONTABILIDAD = new RegExp(/(contabilidad|contable|libros contables|declaraciones|facturaci[oó]n)/, 'i');
  private readonly TRIGGERS_SISTEMAS = new RegExp(/(sistemas|software|redes|computadoras|inform[aá]tica|tecnolog[ií]a)/, 'i');

  private userStates = new Map<string, UserState>();

  private sheets: any;
  private SPREADSHEET_ID!: string;
  private readonly TAB_SLOTS = process.env.SHEETS_TAB_SLOTS || 'Horarios';
  private readonly TAB_APPTS = process.env.SHEETS_TAB_APPOINTMENTS || 'Citas';
  private readonly LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';
  private readonly RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY_MS = 600;

  constructor() {
    this.setupGoogleSheetsAuth().catch((e) =>
      console.error('Error configurando Google Sheets:', e?.message || e)
    );
    
    // Limpiar estados antiguos periódicamente (24 horas)
    setInterval(() => this.cleanOldStates(), 24 * 60 * 60 * 1000);
  }

  private cleanOldStates() {
    const now = Date.now();
    const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
    
    for (const [key, value] of this.userStates.entries()) {
      if ((value.updatedAt || 0) < twentyFourHoursAgo) {
        this.userStates.delete(key);
      }
    }
  }

  /* =========================
     Google Sheets (autenticación robusta)
     ========================= */
  private async setupGoogleSheetsAuth() {
    this.SPREADSHEET_ID = (
      process.env.SHEETS_SPREADSHEET_ID ||
      process.env.GOOGLE_SHEETS_ID ||
      process.env.GOOGLE_SHEET_ID ||
      ''
    ).trim();
    if (!this.SPREADSHEET_ID) {
      throw new Error('Falta SHEETS_SPREADSHEET_ID/GOOGLE_SHEETS_ID (usa SOLO el ID de la planilla, no la URL).');
    }

    const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

    // 1) Preferimos GOOGLE_CREDENTIALS_JSON (JSON directo o base64)
    const raw = process.env.GOOGLE_CREDENTIALS_JSON?.trim();
    if (raw) {
      let creds: any;
      try {
        creds = JSON.parse(raw);
      } catch {
        try {
          const decoded = Buffer.from(raw, 'base64').toString('utf8');
          creds = JSON.parse(decoded);
        } catch {
          throw new Error('GOOGLE_CREDENTIALS_JSON no es JSON válido ni base64 de JSON.');
        }
      }
      const auth = new google.auth.GoogleAuth({ credentials: creds, scopes });
      this.sheets = google.sheets({ version: 'v4', auth });
      console.log('[sheets] auth por GOOGLE_CREDENTIALS_JSON ok');
      return;
    }

    // 2) Si no hay JSON, usar ruta a archivo
    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!keyFile) {
      throw new Error(
        'Faltan credenciales: define GOOGLE_CREDENTIALS_JSON (contenido) o GOOGLE_APPLICATION_CREDENTIALS (ruta a archivo .json).'
      );
    }
    if (keyFile.length > 300) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS debe ser una *ruta* a archivo, no el contenido JSON.');
    }

    const auth = new google.auth.GoogleAuth({ keyFile, scopes });
    this.sheets = google.sheets({ version: 'v4', auth });
    console.log('[sheets] auth por GOOGLE_APPLICATION_CREDENTIALS ok:', keyFile);
  }

  /* =========================
     Envío de mensajes WhatsApp
     ========================= */
  async sendMessage(to: string, message: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar mensaje:', error?.response?.data || error?.message);
      throw new Error('No se pudo enviar el mensaje: ' + (error?.response?.data?.error?.message || error?.message));
    }
  }

  async sendButtons(to: string, message: string, buttons: any[]) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message },
        action: { buttons },
      },
    };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar botones:', error?.response?.data || error?.message);
      throw new Error('No se pudieron enviar los botones: ' + (error?.response?.data?.error?.message || error?.message));
    }
  }

  async sendListMessage(to: string, message: string, buttonText: string, sections: any[]) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: 'Selecciona una opción',
        },
        body: {
          text: message,
        },
        action: {
          button: buttonText,
          sections: sections,
        },
      },
    };
    
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar lista:', error?.response?.data || error?.message);
      // Fallback a botones simples si las listas no están disponibles
      const simpleButtons = sections.flatMap(section => 
        section.rows.map((row: any) => ({
          type: 'reply',
          reply: { id: row.id, title: row.title }
        }))
      ).slice(0, 3);
      
      return this.sendButtons(to, message, simpleButtons);
    }
  }

  async sendImage(to: string, imageUrl: string, caption: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption },
    };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar imagen:', error?.response?.data || error?.message);
      const fallback = `${caption}\n\nSi no puedes ver la imagen, visita este enlace: ${imageUrl}`;
      return this.sendMessage(to, fallback);
    }
  }

  /* ===== Helpers ===== */
  private onlyDigits(s = '') {
    return String(s || '').replace(/[^\d]/g, '');
  }
  
  private detectarTrigger(text: string, regex: RegExp): boolean {
    return regex.test(text.toLowerCase().trim());
  }
  
  private todayYMD() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.LOCAL_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const get = (t: any) => parts.find((p) => p.type === t)?.value || '';
      return { y: +get('year'), m: +get('month'), d: +get('day') };
    } catch {
      const d = new Date();
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    }
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => setTimeout(() => res(), ms));
  }

  /* =========================
     Validaciones
     ========================= */
  private validarTelefono(telefono = ''): boolean {
    const t = this.onlyDigits(telefono);
    return /^\d{7,12}$/.test(t);
  }
  
  private validarEmail(email = ''): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }
  
  private validarNombre(nombre = ''): boolean {
    const parts = String(nombre || '').trim().split(/\s+/);
    return parts.length >= 2 && parts.every((p) => p.length >= 2);
  }

  /* =========================
     Lógica principal
     ========================= */
  async generarRespuesta(text: string, from: string, buttonId?: string): Promise<string> {
    let us = this.userStates.get(from) || { state: 'initial' };
    us.updatedAt = Date.now();
    this.userStates.set(from, us);

    // Limpiar texto de entrada
    const cleanedText = (text || '').trim().toLowerCase();
    
    // Comandos de cancelación en cualquier momento
    if (cleanedText.includes('cancelar') || cleanedText === 'cancelar') {
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      return 'Has cancelado el proceso actual. Escribe "hola" para comenzar de nuevo.';
    }

    // Ayuda en cualquier momento
    if (cleanedText.includes('ayuda') || cleanedText === 'ayuda') {
      return this.getHelpMessage(us.state);
    }

    // Acciones por botones
    if (buttonId) {
      return this.handleButtonAction(buttonId, from, us);
    }

    // FSM por estado
    switch (us.state) {
      case 'awaiting_service_type':
        return this.handleServiceSelection(text, from);
      case 'awaiting_appointment_confirmation':
        return this.handleAppointmentConfirmation(text, from);
      case 'awaiting_slot_choice':
        return this.handleSlotChoice(text, from);
      case 'awaiting_name':
        return this.handleNameInput(text, from);
      case 'awaiting_phone':
        return this.handlePhoneInput(text, from);
      case 'awaiting_email':
        return this.handleEmailInput(text, from);
      case 'confirming_appointment':
        return this.handleAppointmentConfirmationFinal(text, from);
      default:
        return this.handleInitialMessage(text, from);
    }
  }

  private async handleButtonAction(buttonId: string, from: string, us: UserState): Promise<string> {
    switch (buttonId) {
      case 'servicios':
        return this.handleServiceSelection('servicios', from);
      case 'agendar_cita':
        this.userStates.set(from, { 
          ...us, 
          state: 'awaiting_appointment_confirmation', 
          serviceType: 'Por determinar',
          currentStep: 1,
          totalSteps: 5,
          updatedAt: Date.now() 
        });
        return this.sendServiceOptions(from);
      case 'agendar_si':
        return this.handleAppointmentConfirmation('sí', from);
      case 'agendar_no':
        this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
        return 'De acuerdo. Si necesitas algo más, escribe "hola".';
      case 'mas_horarios':
        return this.handleMoreSlotsRequest(from);
      default:
        // Si el botón es de servicio, procesarlo
        if (buttonId.startsWith('serv_')) {
          const serviceType = buttonId.replace('serv_', '').replace(/_/g, ' ');
          this.userStates.set(from, { 
            ...us, 
            state: 'awaiting_appointment_confirmation', 
            serviceType,
            currentStep: 1,
            totalSteps: 5,
            updatedAt: Date.now() 
          });
          return `Has seleccionado: *${serviceType}*. ¿Te gustaría agendar una cita ahora?`;
        }
        return 'No reconozco ese comando. Escribe "hola" para comenzar.';
    }
  }

  private async handleInitialMessage(text: string, from: string): Promise<string> {
    const t = (text || '').toLowerCase().trim();
    
    // Saludos
    if (/(^|\b)(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches|inicio|empezar)(\b|$)/i.test(t)) {
      await this.sendWelcomeButtons(from);
      this.userStates.set(from, { state: 'awaiting_service_type', updatedAt: Date.now() });
      return '';
    }
    
    // Agradecimientos
    if (t.includes('gracias') || t.includes('thank you')) {
      return '¡Gracias a ti! ¿Necesitas algo más? Escribe "hola" para volver al menú.';
    }
    
    // Despedidas
    if (/(adiós|chao|hasta luego|bye)/i.test(t)) {
      return '¡Hasta luego! Si necesitas algo más, escribe "hola".';
    }

    // Detección de servicios por palabras clave
    let detectedService = '';
    if (this.detectarTrigger(t, this.TRIGGERS_TRIBUTARIO)) {
      detectedService = 'Asesoría tributaria';
    } else if (this.detectarTrigger(t, this.TRIGGERS_LEGAL)) {
      detectedService = 'Asesoría legal';
    } else if (this.detectarTrigger(t, this.TRIGGERS_LABORAL)) {
      detectedService = 'Asesoría laboral';
    } else if (this.detectarTrigger(t, this.TRIGGERS_CONTABILIDAD)) {
      detectedService = 'Contabilidad tercerizada';
    } else if (this.detectarTrigger(t, this.TRIGGERS_SISTEMAS)) {
      detectedService = 'Revisión de sistemas informáticos';
    }

    if (detectedService) {
      this.userStates.set(from, { 
        state: 'awaiting_appointment_confirmation', 
        serviceType: detectedService,
        currentStep: 1,
        totalSteps: 5,
        updatedAt: Date.now() 
      });
      return `He detectado que necesitas: *${detectedService}*. ¿Te gustaría agendar una cita ahora?`;
    }

    return '🤔 No entendí tu mensaje. Escribe "hola" para empezar o elige una de las opciones en pantalla.';
  }

  private getHelpMessage(currentState: string): string {
    const helpMessages: {[key: string]: string} = {
      'initial': 'Puedes escribir "hola" para comenzar o "servicios" para ver nuestras opciones.',
      'awaiting_service_type': 'Por favor, selecciona uno de nuestros servicios o escribe el nombre del servicio que necesitas.',
      'awaiting_appointment_confirmation': 'Responde "sí" para agendar una cita o "no" para volver al menú principal.',
      'awaiting_slot_choice': 'Selecciona el número del horario que prefieres o escribe "más" para ver más opciones.',
      'awaiting_name': 'Por favor, escribe tu nombre completo (nombre y apellido).',
      'awaiting_phone': 'Por favor, escribe tu número de teléfono (7-12 dígitos).',
      'awaiting_email': 'Por favor, escribe tu dirección de email.',
      'confirming_appointment': 'Responde "sí" para confirmar tu cita o "no" para volver a empezar.'
    };
    
    return helpMessages[currentState] || 'Escribe "hola" para comenzar o "cancelar" en cualquier momento para reiniciar.';
  }

  /* =========================
     Bienvenida y selección de servicio
     ========================= */
  private async sendWelcomeButtons(to: string) {
    const buttons = [
      { type: 'reply', reply: { id: 'servicios', title: 'Ver servicios' } },
      { type: 'reply', reply: { id: 'agendar_cita', title: 'Agendar cita' } },
    ];
    const message =
      '¡Hola! 👋 Bienvenido a nuestros servicios profesionales. ¿En qué puedo ayudarte hoy?\n\n' +
      'Puedes seleccionar una opción o escribir directamente qué servicio necesitas.';
    await this.sendButtons(to, message, buttons);
  }

  private async sendServiceOptions(to: string) {
    const sections = [
      {
        title: 'Nuestros Servicios',
        rows: [
          { id: 'serv_Asesoría_tributaria', title: 'Asesoría Tributaria' },
          { id: 'serv_Asesoría_legal', title: 'Asesoría Legal' },
          { id: 'serv_Asesoría_laboral', title: 'Asesoría Laboral' },
          { id: 'serv_Contabilidad_tercerizada', title: 'Contabilidad' },
          { id: 'serv_Sistemas_informáticos', title: 'Sistemas Informáticos' },
        ]
      }
    ];
    
    const message = 'Te ayudo a agendar una cita. Primero, por favor selecciona el tipo de servicio que necesitas:';
    await this.sendListMessage(to, message, 'Ver servicios', sections);
    return '';
  }

  private async handleServiceSelection(text: string, from: string): Promise<string> {
    const tl = text.toLowerCase().trim();
    let serviceType = '';
    
    if (this.detectarTrigger(tl, this.TRIGGERS_TRIBUTARIO) || 
        this.detectarTrigger(tl, this.TRIGGERS_LEGAL) || 
        this.detectarTrigger(tl, this.TRIGGERS_LABORAL)) {
      serviceType = 'Asesoría tributaria, legal y laboral';
    } else if (this.detectarTrigger(tl, this.TRIGGERS_CONTABILIDAD)) {
      serviceType = 'Contabilidad tercerizada';
    } else if (this.detectarTrigger(tl, this.TRIGGERS_SISTEMAS)) {
      serviceType = 'Revisión de sistemas informáticos';
    } else if (tl === 'ver servicios' || tl === 'servicios') {
      await this.sendServiceOptions(from);
      return '';
    } else if (tl === 'agendar cita' || tl === 'agendar_cita') {
      await this.sendServiceOptions(from);
      return '';
    } else {
      serviceType = text; // Usar el texto directamente si no coincide con triggers
    }

    const st = this.userStates.get(from) || { state: 'awaiting_service_type' };
    st.serviceType = serviceType;
    st.state = 'awaiting_appointment_confirmation';
    st.currentStep = 1;
    st.totalSteps = 5;
    st.updatedAt = Date.now();
    this.userStates.set(from, st);

    const redirectMessage =
      `He identificado que necesitas: *${serviceType}*.\n\n` +
      `¿Te gustaría agendar una cita ahora?`;

    const buttons = [
      { type: 'reply', reply: { id: 'agendar_si', title: 'Sí, agendar cita' } },
      { type: 'reply', reply: { id: 'agendar_no', title: 'No, gracias' } },
    ];
    await this.sendButtons(from, redirectMessage, buttons);
    return '';
  }

  private async handleAppointmentConfirmation(text: string, from: string): Promise<string> {
    const t = text.toLowerCase().trim();
    if (/(^|\b)(si|sí|agendar_si|sí, agendar|si, agendar)/i.test(t)) {
      const slots = await this.getAvailableSlotsFromSheets(5, 14); // Más días de búsqueda
      
      if (!slots.length) {
        const alternativeMessage = 
          'Lo siento, no hay horarios disponibles en este momento.\n\n' +
          'Te sugiero:\n' +
          '1. Intentar de nuevo en unas horas\n' +
          '2. Contactarnos directamente al +591 65900645\n' +
          '3. Solicitar una llamada de seguimiento\n\n' +
          '¿Deseas que te contactemos?';
        
        const buttons = [
          { type: 'reply', reply: { id: 'contact_call', title: 'Sí, contáctenme' } },
          { type: 'reply', reply: { id: 'try_later', title: 'Intentaré más tarde' } },
        ];
        await this.sendButtons(from, alternativeMessage, buttons);
        return '';
      }
      
      let msg = `Paso ${2} de ${5}: Estos son los horarios disponibles:\n\n`;
      slots.forEach((s, i) => (msg += `${i + 1}. ${s.label}\n`));
      msg += '\nResponde con el número de la opción que prefieres (ej. 1) o escribe "más" para ver más opciones.';
      
      const st = this.userStates.get(from) || { state: 'awaiting_appointment_confirmation' };
      st.lastOfferedSlots = slots;
      st.state = 'awaiting_slot_choice';
      st.currentStep = 2;
      st.updatedAt = Date.now();
      this.userStates.set(from, st);
      
      return msg;
    } else {
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      return 'De acuerdo. Si necesitas algo más escribe "hola". ¡Que tengas un buen día!';
    }
  }

  private async handleMoreSlotsRequest(from: string): Promise<string> {
    const st = this.userStates.get(from);
    if (!st) return 'No tengo registro de tu solicitud. Por favor, escribe "hola" para comenzar.';
    
    // Obtener más slots (empezando desde donde quedamos)
    const startIndex = st.lastOfferedSlots ? st.lastOfferedSlots.length : 0;
    const additionalSlots = await this.getAvailableSlotsFromSheets(5, 14, startIndex);
    
    if (!additionalSlots.length) {
      return 'No hay más horarios disponibles en este momento. Por favor, elige entre las opciones anteriores o intenta más tarde.';
    }
    
    // Combinar con los slots anteriores
    const allSlots = [...(st.lastOfferedSlots || []), ...additionalSlots];
    st.lastOfferedSlots = allSlots;
    this.userStates.set(from, st);
    
    let msg = `Más horarios disponibles:\n\n`;
    additionalSlots.forEach((s, i) => {
      const num = i + 1 + (st.lastOfferedSlots?.length || 0) - additionalSlots.length;
      msg += `${num}. ${s.label}\n`;
    });
    msg += '\nResponde con el número de la opción que prefieres.';
    
    return msg;
  }

  private async handleSlotChoice(text: string, from: string): Promise<string> {
    const t = text.toLowerCase().trim();
    
    // Manejar solicitud de más horarios
    if (t === 'más' || t === 'mas' || t === 'more') {
      return this.handleMoreSlotsRequest(from);
    }
    
    const n = parseInt(t, 10);
    const st = this.userStates.get(from);
    
    if (!st || !Array.isArray(st.lastOfferedSlots) || !Number.isFinite(n) || n < 1 || n > st.lastOfferedSlots.length) {
      return 'Por favor, envía un número válido de la lista anterior (ej. 1) o escribe "más" para ver más opciones.';
    }
    
    const chosen = st.lastOfferedSlots[n - 1];

    // Intentar reservar en la hoja
    const ok = await this.reserveSlotRow(chosen.row, from).catch(() => false);
    if (!ok) {
      // Ofrecer alternativas si el slot ya no está disponible
      const alternativeMessage = 
        'Ese horario acaba de ocuparse 😕. ¿Deseas:\n\n' +
        '1. Ver otros horarios disponibles\n' +
        '2. Que te contactemos para coordinar\n' +
        '3. Recibir notificación cuando haya disponibilidad';
      
      const buttons = [
        { type: 'reply', reply: { id: 'more_slots', title: 'Ver otros horarios' } },
        { type: 'reply', reply: { id: 'contact_me', title: 'Que me contacten' } },
      ];
      
      await this.sendButtons(from, alternativeMessage, buttons);
      return '';
    }

    // Guardar selección y avanzar al siguiente paso
    st.appointmentDate = chosen.date;
    st.appointmentTime = chosen.time;
    st.state = 'awaiting_name';
    st.currentStep = 3;
    st.updatedAt = Date.now();
    this.userStates.set(from, st);

    return `✅ ¡Perfecto! He reservado *${chosen.label}*.\n\nPaso ${3} de ${5}: Por favor, escribe tu *nombre completo* (nombre y apellido).`;
  }

  private async handleNameInput(text: string, from: string): Promise<string> {
    const name = text.trim();
    
    if (!this.validarNombre(name)) {
      return 'Por favor, escribe tu nombre completo (al menos dos palabras con 2+ caracteres cada una). Ejemplo: María González';
    }
    
    const st = this.userStates.get(from);
    if (!st) return 'No tengo registro de tu solicitud. Por favor, escribe "hola" para comenzar.';
    
    if (!st.clientData) st.clientData = {};
    st.clientData.nombre = name;
    st.state = 'awaiting_phone';
    st.currentStep = 4;
    st.updatedAt = Date.now();
    this.userStates.set(from, st);
    
    return `Paso ${4} de ${5}: Gracias ${name}. Ahora escribe tu *número de teléfono* (7-12 dígitos).`;
  }

  private async handlePhoneInput(text: string, from: string): Promise<string> {
    const phone = this.onlyDigits(text);
    
    if (!this.validarTelefono(phone)) {
      return 'Por favor, escribe un número de teléfono válido (7-12 dígitos). Ejemplo: 65900645';
    }
    
    const st = this.userStates.get(from);
    if (!st) return 'No tengo registro de tu solicitud. Por favor, escribe "hola" para comenzar.';
    
    if (!st.clientData) st.clientData = {};
    st.clientData.telefono = phone;
    st.state = 'awaiting_email';
    st.currentStep = 5;
    st.updatedAt = Date.now();
    this.userStates.set(from, st);
    
    return `Paso ${5} de ${5}: Ahora escribe tu *dirección de email* para enviarte la confirmación.`;
  }

  private async handleEmailInput(text: string, from: string): Promise<string> {
    const email = text.trim();
    
    if (!this.validarEmail(email)) {
      return 'Por favor, escribe una dirección de email válida. Ejemplo: nombre@ejemplo.com';
    }
    
    const st = this.userStates.get(from);
    if (!st) return 'No tengo registro de tu solicitud. Por favor, escribe "hola" para comenzar.';
    
    if (!st.clientData) st.clientData = {};
    st.clientData.email = email;
    st.state = 'confirming_appointment';
    st.updatedAt = Date.now();
    this.userStates.set(from, st);
    
    // Mostrar resumen para confirmación
    const summary = 
      `📋 *Resumen de tu cita:*\n\n` +
      `👤 *Nombre:* ${st.clientData.nombre}\n` +
      `📞 *Teléfono:* ${st.clientData.telefono}\n` +
      `✉️ *Email:* ${st.clientData.email}\n` +
      `🧾 *Servicio:* ${st.serviceType}\n` +
      `📅 *Fecha:* ${st.appointmentDate}\n` +
      `🕒 *Hora:* ${st.appointmentTime}\n\n` +
      `¿Confirmas que todos los datos son correctos?`;
    
    const buttons = [
      { type: 'reply', reply: { id: 'confirm_yes', title: 'Sí, confirmar' } },
      { type: 'reply', reply: { id: 'confirm_no', title: 'No, corregir' } },
    ];
    
    await this.sendButtons(from, summary, buttons);
    return '';
  }

  private async handleAppointmentConfirmationFinal(text: string, from: string): Promise<string> {
    const t = text.toLowerCase().trim();
    const st = this.userStates.get(from);
    
    if (!st) return 'No tengo registro de tu solicitud. Por favor, escribe "hola" para comenzar.';
    
    if (/(^|\b)(si|sí|confirmar|confirmo|confirm_yes)/i.test(t)) {
      try {
        await this.appendAppointmentRow({
          telefono: st.clientData?.telefono!,
          nombre: st.clientData?.nombre!,
          email: st.clientData?.email!,
          servicio: st.serviceType || 'Sin especificar',
          fecha: st.appointmentDate!,
          hora: st.appointmentTime!,
          slotRow: st.lastOfferedSlots?.find((s) => s.date === st.appointmentDate && s.time === st.appointmentTime)?.row || '',
        });
      } catch (e) {
        console.error('Error guardando cita en Sheets:', e);
        return 'Ocurrió un problema al guardar tu cita. Por favor intenta nuevamente más tarde o llama al +591 65900645.';
      }

      const confirmadoMsg = `✅ *¡Cita confirmada!*\n\nGracias por agendar con nosotros. Te esperamos el ${st.appointmentDate} a las ${st.appointmentTime}.\n\nSi necesitas cancelar o reprogramar, contáctanos al +591 65900645.`;

      await this.sendMessage(from, confirmadoMsg);

      // Generar y enviar PDF de confirmación
      try {
        const pdfUrl = await this.generateConfirmationPDF({
          clientData: st.clientData!,
          serviceType: st.serviceType,
          appointmentDate: st.appointmentDate,
          appointmentTime: st.appointmentTime,
        });
        if (pdfUrl) {
          await this.sendImage(from, pdfUrl, 'Aquí tienes tu comprobante de cita. Guárdalo como comprobante.');
        }
      } catch (e) {
        console.error('Error generando PDF:', e);
      }

      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      return '¿Necesitas algo más? Escribe "hola" para volver al menú.';
      
    } else {
      // Volver al inicio para corregir
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      return 'De acuerdo, volvamos al inicio. Escribe "hola" para comenzar de nuevo.';
    }
  }

  /* =========================
     Sheets - Helpers con reintentos
     ========================= */
  private async sheetsRequest<T>(fn: () => Promise<T>, attempts = this.RETRY_ATTEMPTS): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        await this.sleep(this.RETRY_DELAY_MS * (i + 1));
      }
    }
    throw lastErr;
  }

  private async getAvailableSlotsFromSheets(max = 5, daysAhead = 7, startIndex = 0): Promise<SlotOffered[]> {
    const { y, m, d } = this.todayYMD();
    const today = new Date(Date.UTC(y, m - 1, d));
    const until = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const r: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.SPREADSHEET_ID,
        range: `${this.TAB_SLOTS}!A2:E`,
      })
    );

    const rows: string[][] = r.data.values || [];
    const out: SlotOffered[] = [];
    
    for (let i = startIndex; i < rows.length; i++) {
      const rowIdx = i + 2; // fila real
      const [fecha, hora, estado] = [rows[i][0] || '', rows[i][1] || '', (rows[i][2] || '').toUpperCase()];
      
      if (estado !== 'DISPONIBLE') continue;
      
      const parts = (fecha || '').split('-').map(Number);
      if (parts.length !== 3) continue;
      
      const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      if (dt < today || dt > until) continue;
      
      const label = `${fecha} a las ${hora}`;
      out.push({ row: rowIdx, date: fecha, time: hora, label });
      
      if (out.length >= max) break;
    }
    
    return out;
  }

  private async reserveSlotRow(rowNumber: number, byPhone: string): Promise<boolean> {
    const stateRange = `${this.TAB_SLOTS}!C${rowNumber}:E${rowNumber}`;
    
    const read: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.SPREADSHEET_ID,
        range: stateRange,
      })
    );
    
    const cur = (read.data.values && read.data.values[0]) || [];
    const currentState = (cur[0] || '').toUpperCase();
    
    if (currentState !== 'DISPONIBLE') return false;

    await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.update({
        spreadsheetId: this.SPREADSHEET_ID,
        range: stateRange,
        valueInputOption: 'RAW',
        requestBody: { values: [['RESERVADO', new Date().toISOString(), this.onlyDigits(byPhone)]] },
      })
    );
    
    return true;
  }

  private async appendAppointmentRow(opts: {
    telefono: string;
    nombre: string;
    email: string;
    servicio: string;
    fecha: string;
    hora: string;
    slotRow: number | string;
  }) {
    const row = [
      new Date().toISOString(),
      this.onlyDigits(opts.telefono || ''),
      String(opts.nombre || ''),
      String(opts.email || ''),
      String(opts.servicio || ''),
      String(opts.fecha || ''),
      String(opts.hora || ''),
      'CONFIRMADA',
      String(opts.slotRow || ''),
      '', // calendar_event_id (lo pondrá Apps Script)
    ];
    
    await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.append({
        spreadsheetId: this.SPREADSHEET_ID,
        range: `${this.TAB_APPTS}!A1:J`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      })
    );
  }

  /* =========================
     PDF con QR
     ========================= */
  private async generateConfirmationPDF(state: any): Promise<string | null> {
    try {
      const safeName = (state.clientData?.nombre || 'Cliente').replace(/\s+/g, '_');
      const fileName = `cita_${safeName}_${Date.now()}.pdf`;
      const tmpDir = path.join(__dirname, '..', 'tmp');
      await fsp.mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, fileName);

      // QR con info esencial
      const qrText = JSON.stringify({
        nombre: state.clientData?.nombre,
        telefono: state.clientData?.telefono,
        email: state.clientData?.email,
        fecha: state.appointmentDate,
        hora: state.appointmentTime,
        servicio: state.serviceType,
      });
      
      const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', errorCorrectionLevel: 'M' });

      // Crear PDF
      const doc = new PDFDocument({ margin: 40 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Intentar añadir logo si existe
      const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, { width: 120 });
        } catch {
          /* ignore */
        }
      }

      doc.moveDown(1);
      doc.fontSize(18).text('Confirmación de Cita', { align: 'center' });
      doc.moveDown(1);
      
      // Información de la cita
      doc.fontSize(12);
      doc.text(`Nombre: ${state.clientData?.nombre || ''}`);
      doc.text(`Teléfono: ${state.clientData?.telefono || ''}`);
      doc.text(`Email: ${state.clientData?.email || ''}`);
      doc.moveDown(0.5);
      doc.text(`Servicio: ${state.serviceType || ''}`);
      doc.text(`Fecha: ${state.appointmentDate || ''}`);
      doc.text(`Hora: ${state.appointmentTime || ''}`);
      doc.moveDown(1);
      
      // Instrucciones
      doc.text('Por favor:', { underline: true });
      doc.text('• Presentarse 5 minutos antes de la cita');
      doc.text('• Traer documentación relevante');
      doc.text('• Contactarnos al +591 65900645 en caso de inconvenientes');
      doc.moveDown(1);
      
      // Insertar QR
      try {
        doc.image(qrBuffer, doc.page.width - 150, doc.y, { width: 100 });
        doc.moveDown(3);
      } catch {
        /* ignore */
      }
      
      doc.text(`ID de reserva: ${Date.now()}`, { oblique: true });
      doc.end();

      // Esperar a que termine de escribirse
      await new Promise<void>((resolve, reject) => {
        stream.on('finish', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      // TODO: Implementar subida a almacenamiento cloud y devolver URL pública
      return `https://ejemplo.com/pdfs/${fileName}`;
    } catch (e) {
      console.error('Error generando PDF:', e);
      return null;
    }
  }
}