// src/whatsapp.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { google } from 'googleapis';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import * as FormData from 'form-data';

// (Opcional) S3 para link público
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const COMPANY_NAME = 'Russell Bedford Bolivia Encinas Auditores y Consultores SRL';

type ClientData = {
  nombre?: string;
  telefono?: string;
  email?: string;
  servicio?: string;
  fecha?: string;
  hora?: string;
};

type SlotOffered = { row: number; date: string; time: string; label: string; fallback?: boolean };

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

type FieldKey = 'nombre' | 'telefono' | 'email';
type FormField = {
  key: FieldKey;
  prompt: (ctx: any) => string;
  validate: (v: string) => true | string;
  normalize?: (v: string) => string;
  optional?: boolean;
};

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  private readonly SERVICE_CATALOG = [
    { id: 'tributario', label: 'Asesoría Tributaria', aliases: ['impuestos', 'fiscal', 'sat', 'tributaria'] },
    { id: 'legal', label: 'Asesoría Legal', aliases: ['contrato', 'abogado', 'ley', 'juridico', 'jurídico'] },
    { id: 'laboral', label: 'Asesoría Laboral', aliases: ['empleo', 'trabajo', 'contratación', 'despido'] },
    { id: 'conta', label: 'Contabilidad', aliases: ['contable', 'libros', 'declaraciones', 'facturación', 'facturacion'] },
    { id: 'sistemas', label: 'Sistemas Informáticos', aliases: ['software', 'redes', 'informática', 'informatica', 'tecnología', 'tecnologia'] },
  ];

  private userStates = new Map<string, UserState>();

  private forms = new Map<
    string,
    {
      idx: number;
      data: ClientData;
      schema: FormField[];
      serviceType: string;
      slots: SlotOffered[];
      autofilledPhone: string;
    }
  >();

  private readonly FORM_APPT: FormField[] = [
    {
      key: 'nombre',
      prompt: () => '🧍‍♀️ *Paso 1/3*: ¿Cuál es tu *nombre y apellido*?',
      validate: (v) => {
        const parts = String(v || '').trim().split(/\s+/);
        return (parts.length >= 2 && parts.every((p) => p.length >= 2)) || 'Escribe nombre y apellido (ej. María González).';
      },
    },
    {
      key: 'telefono',
      prompt: (ctx) =>
        `📞 *Paso 2/3*: ¿Confirmas este *número* para contactarte: *${ctx.autofilledPhone}*?\n\nResponde con:\n• *sí* para usarlo\n• O escribe otro número (7–12 dígitos)`,
      validate: (v) => /^\d{7,12}$/.test(String(v || '').replace(/[^\d]/g, '')) || 'Número inválido, usa 7–12 dígitos (ej. 65900645).',
      normalize: (v) => String(v || '').replace(/[^\d]/g, ''),
    },
    {
      key: 'email',
      prompt: () => '✉️ *Paso 3/3*: ¿Cuál es tu *email* para enviarte la confirmación?\n\nSi no tienes, escribe *omitir*.',
      validate: (v) =>
        v === 'omitir' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()) || 'Email inválido (ej. nombre@ejemplo.com).',
      optional: true,
      normalize: (v) => (v === 'omitir' ? '' : String(v || '').trim()),
    },
  ];

  // S3 opcional
  private s3: S3Client | null =
    process.env.AWS_S3_BUCKET && process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? new S3Client({
          region: process.env.AWS_REGION!,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          },
        })
      : null;

  private sheets: any;
  private SPREADSHEET_ID!: string;
  private readonly TAB_SLOTS = process.env.SHEETS_TAB_SLOTS || 'Horarios';
  private readonly TAB_APPTS = process.env.SHEETS_TAB_APPOINTMENTS || 'Citas';
  private readonly LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';
  private readonly RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY_MS = 600;

  constructor() {
    this.setupGoogleSheetsAuth().catch((e) => console.error('Error configurando Google Sheets:', e?.message || e));
    setInterval(() => this.cleanOldStates(), 24 * 60 * 60 * 1000);
  }

  private cleanOldStates() {
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    for (const [key, value] of this.userStates.entries()) {
      if ((value.updatedAt || 0) < twentyFourHoursAgo) this.userStates.delete(key);
    }
    for (const [key] of this.forms.entries()) {
      const st = this.userStates.get(key);
      if (!st || (st.updatedAt || 0) < twentyFourHoursAgo) this.forms.delete(key);
    }
  }

  /* =========================
     Google Sheets (auth robusta)
     ========================= */
  private async setupGoogleSheetsAuth() {
    this.SPREADSHEET_ID = (process.env.SHEETS_SPREADSHEET_ID || process.env.GOOGLE_SHEETS_ID || process.env.GOOGLE_SHEET_ID || '').trim();
    if (!this.SPREADSHEET_ID) throw new Error('Falta SHEETS_SPREADSHEET_ID/GOOGLE_SHEETS_ID (usa SOLO el ID de la planilla, no la URL).');

    const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

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

    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!keyFile) throw new Error('Faltan credenciales: define GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS (ruta al .json).');
    if (keyFile.length > 300) throw new Error('GOOGLE_APPLICATION_CREDENTIALS debe ser una *ruta* a archivo, no JSON inline.');

    const auth = new google.auth.GoogleAuth({ keyFile, scopes });
    this.sheets = google.sheets({ version: 'v4', auth });
    console.log('[sheets] auth por GOOGLE_APPLICATION_CREDENTIALS ok:', keyFile);
  }

  /* =========================
     WhatsApp: utilidades de envío
     ========================= */
  async sendMessage(to: string, message: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: message } };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar mensaje:', error?.response?.data || error?.message);
      throw new Error('No se pudo enviar el mensaje: ' + (error?.response?.data?.error?.message || error?.message));
    }
  }

  async sendButtons(to: string, message: string, buttons: any[]) {
    const safeButtons = buttons.slice(0, 3); // Máx 3
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: { type: 'button', body: { text: message }, action: { buttons: safeButtons } },
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
        header: { type: 'text', text: 'Selecciona una opción' },
        body: { text: message },
        action: { button: buttonText, sections },
      },
    };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar lista:', error?.response?.data || error?.message);
      const simpleButtons = sections
        .flatMap((section) => section.rows.map((row: any) => ({ type: 'reply', reply: { id: row.id, title: row.title } })))
        .slice(0, 3);
      return this.sendButtons(to, message, simpleButtons);
    }
  }

  async uploadMediaToWhatsApp(buffer: Buffer, filename: string, mime = 'application/pdf'): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { filename, contentType: mime });

    const url = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
    const res = await axios.post(url, form, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`, ...form.getHeaders() } });
    return res.data.id as string;
  }

  async sendDocumentByMediaId(to: string, mediaId: string, filename: string, caption: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, caption, filename },
    };
    const res = await axios.post(this.API_URL, body, { headers: this.HEADERS });
    return res.data;
  }

  async sendDocumentByLink(to: string, fileUrl: string, filename: string, caption: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { link: fileUrl, caption, filename },
    };
    const res = await axios.post(this.API_URL, body, { headers: this.HEADERS });
    return res.data;
  }

  /* ===== Helpers ===== */
  private onlyDigits(s = '') {
    return String(s || '').replace(/[^\d]/g, '');
  }
  private normalize(t = '') {
    return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }
  private findServiceFromText(text: string): { id: string; label: string } | null {
    const n = this.normalize(text);
    let best: { id: string; label: string; score: number } | null = null;
    for (const s of this.SERVICE_CATALOG) {
      let score = 0;
      if (n.includes(this.normalize(s.label))) score += 3;
      for (const a of s.aliases) if (n.includes(this.normalize(a))) score += 1;
      if (score > 0 && (!best || score > best.score)) best = { id: s.id, label: s.label, score };
    }
    return best ? { id: best.id, label: best.label } : null;
  }

  private todayYMD(): { y: number; m: number; day: number } {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.LOCAL_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const get = (t: any) => parts.find((p) => p.type === t)?.value || '';
      return { y: +get('year'), m: +get('month'), day: +get('day') };
    } catch {
      const now = new Date();
      return { y: now.getFullYear(), m: now.getMonth() + 1, day: now.getDate() };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => setTimeout(() => res(), ms));
  }

  private parseFlexibleDate(str: string): { y: number; m: number; day: number } | null {
    const a = String(str || '').trim();
    let m;
    if ((m = a.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
      return { y: +m[1], m: +m[2], day: +m[3] };
    }
    if ((m = a.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) {
      return { y: +m[3], m: +m[2], day: +m[1] };
    }
    return null;
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

    const cleanedText = (text || '').trim().toLowerCase();

    if (cleanedText === 'cancelar' || cleanedText.includes('cancelar')) {
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      this.forms.delete(from);
      return 'Has cancelado el proceso actual. Escribe "hola" para comenzar de nuevo.';
    }

    if (cleanedText === 'ayuda' || cleanedText.includes('ayuda')) {
      return this.getHelpMessage(us.state);
    }

    if (buttonId) {
      return this.handleButtonAction(buttonId, from, us);
    }

    if (this.forms.has(from)) {
      return this.handleFormInput(from, text);
    }

    switch (us.state) {
      case 'awaiting_service_type':
        return this.handleServiceSelection(text, from);
      case 'awaiting_appointment_confirmation':
        return this.handleAppointmentConfirmation(text, from);
      case 'awaiting_slot_choice':
        return this.handleSlotChoice(text, from);
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
          serviceType: us.serviceType || 'Por definir',
          currentStep: 1,
          totalSteps: 5,
          updatedAt: Date.now(),
        });
        return this.sendServiceOptions(from);
      case 'agendar_si':
        return this.handleAppointmentConfirmation('sí', from);
      case 'agendar_no':
        this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
        this.forms.delete(from);
        return 'De acuerdo. Si necesitas algo más, escribe "hola".';
      case 'mas_horarios':
      case 'more_slots':
        return this.handleMoreSlotsRequest(from);
      case 'confirm_yes':
        if (this.forms.has(from)) return this.finalizeFormConfirmation(from);
        return 'No encontré un formulario activo para confirmar. Escribe "hola" para comenzar.';
      case 'confirm_no':
        this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
        this.forms.delete(from);
        return 'De acuerdo, volvamos al inicio. Escribe "hola" para comenzar de nuevo.';
      case 'confirm_edit':
        await this.sendButtons(from, '¿Qué te gustaría *editar*?', [
          { type: 'reply', reply: { id: 'edit_nombre', title: '✏️ Nombre' } },
          { type: 'reply', reply: { id: 'edit_telefono', title: '✏️ Teléfono' } },
          { type: 'reply', reply: { id: 'edit_email', title: '✏️ Email' } },
        ]);
        return '';
      case 'edit_nombre':
      case 'edit_telefono':
      case 'edit_email': {
        const key = buttonId.replace('edit_', '') as FieldKey;
        const f = this.forms.get(from);
        if (f) {
          const idx = f.schema.findIndex((s) => s.key === key);
          if (idx >= 0) {
            f.idx = idx;
            await this.askNext(from);
            return '';
          }
        }
        return 'No encontré el formulario activo. Escribe "hola" para comenzar de nuevo.';
      }
      default:
        if (buttonId.startsWith('serv_')) {
          const serviceType = buttonId.replace('serv_', '').replace(/_/g, ' ');
          this.userStates.set(from, {
            ...us,
            state: 'awaiting_appointment_confirmation',
            serviceType,
            currentStep: 1,
            totalSteps: 5,
            updatedAt: Date.now(),
          });
          const msg = `Has seleccionado: *${serviceType}*.\n\n¿Te gustaría ver horarios y agendar ahora?`;
          await this.sendButtons(from, msg, [
            { type: 'reply', reply: { id: 'agendar_si', title: 'Sí, agendar ahora' } },
            { type: 'reply', reply: { id: 'agendar_no', title: 'No, gracias' } },
          ]);
          return '';
        }
        return 'No reconozco ese comando. Escribe "hola" para comenzar.';
    }
  }

  private async handleInitialMessage(text: string, from: string): Promise<string> {
    const t = (text || '').toLowerCase().trim();

    if (/(^|\b)(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches|inicio|empezar)(\b|$)/i.test(t)) {
      await this.sendWelcomeButtons(from);
      this.userStates.set(from, { state: 'awaiting_service_type', updatedAt: Date.now() });
      return '';
    }

    if (t.includes('gracias') || t.includes('thank you')) return '¡Gracias a ti! ¿Necesitas algo más? Escribe "hola" para volver al menú.';
    if (/(adiós|chao|hasta luego|bye)/i.test(t)) return '¡Hasta luego! Si necesitas algo más, escribe "hola".';

    const matched = this.findServiceFromText(t);
    if (matched) {
      this.userStates.set(from, {
        state: 'awaiting_appointment_confirmation',
        serviceType: matched.label,
        currentStep: 1,
        totalSteps: 5,
        updatedAt: Date.now(),
      });
      const msg = `He detectado que necesitas: *${matched.label}*.\n\n¿Quieres ver *horarios disponibles* y agendar ahora?`;
      await this.sendButtons(from, msg, [
        { type: 'reply', reply: { id: 'agendar_si', title: 'Sí, agendar ahora' } },
        { type: 'reply', reply: { id: 'agendar_no', title: 'No, gracias' } },
      ]);
      return '';
    }

    return '🤔 No entendí tu mensaje. Escribe "hola" para empezar o toca *Ver servicios*.';
  }

  private getHelpMessage(currentState: string): string {
    const helpMessages: { [key: string]: string } = {
      initial: 'Puedes escribir "hola" para comenzar o "servicios" para ver nuestras opciones.',
      awaiting_service_type: 'Selecciona un servicio o escribe lo que necesitas (ej. impuestos, contrato, contabilidad).',
      awaiting_appointment_confirmation: 'Responde "sí" para ver horarios y agendar, o "no" para volver al menú.',
      awaiting_slot_choice: 'Envía el número del horario que prefieras o escribe "más" para ver más opciones.',
    };
    return helpMessages[currentState] || 'Escribe "hola" para comenzar o "cancelar" en cualquier momento para reiniciar.';
  }

  private async sendWelcomeButtons(to: string) {
    const buttons = [
      { type: 'reply', reply: { id: 'servicios', title: '🧾 Ver servicios' } },
      { type: 'reply', reply: { id: 'agendar_cita', title: '📅 Agendar ahora' } },
    ];
    const message =
      `👋 Bienvenido a *${COMPANY_NAME}*.\n` +
      `Agenda en *2 minutos*: te mostramos *horarios reales* y recibes *confirmación en PDF*.\n\n` +
      `Elige una opción o cuéntame qué necesitas.`;
    await this.sendButtons(to, message, buttons);
  }

  private async sendServiceOptions(to: string) {
    const sections = [
      {
        title: 'Nuestros Servicios',
        rows: [
          { id: 'serv_Asesoría_Tributaria', title: 'Asesoría Tributaria' },
          { id: 'serv_Asesoría_Legal', title: 'Asesoría Legal' },
          { id: 'serv_Asesoría_Laboral', title: 'Asesoría Laboral' },
          { id: 'serv_Contabilidad', title: 'Contabilidad' },
          { id: 'serv_Sistemas_Informáticos', title: 'Sistemas Informáticos' },
        ],
      },
    ];
    const message = 'Primero, selecciona el *tipo de servicio* que necesitas:';
    await this.sendListMessage(to, message, 'Ver servicios', sections);
    return '';
  }

  private async handleServiceSelection(text: string, from: string): Promise<string> {
    const tl = text.toLowerCase().trim();
    let serviceType = '';

    if (tl === 'ver servicios' || tl === 'servicios' || tl === 'agendar cita' || tl === 'agendar_cita') {
      await this.sendServiceOptions(from);
      return '';
    }

    const matched = this.findServiceFromText(text);
    serviceType = matched ? matched.label : text;

    const st = this.userStates.get(from) || { state: 'awaiting_service_type' };
    st.serviceType = serviceType;
    st.state = 'awaiting_appointment_confirmation';
    st.currentStep = 1;
    st.totalSteps = 5;
    st.updatedAt = Date.now();
    this.userStates.set(from, st);

    const redirectMessage = `Trabajamos *${serviceType}*.\n\n¿Quieres ver *horarios disponibles* y agendar ahora?`;
    await this.sendButtons(from, redirectMessage, [
      { type: 'reply', reply: { id: 'agendar_si', title: 'Sí, agendar ahora' } },
      { type: 'reply', reply: { id: 'agendar_no', title: 'No, gracias' } },
    ]);
    return '';
  }

  private async handleAppointmentConfirmation(text: string, from: string): Promise<string> {
    const t = text.toLowerCase().trim();
    if (/(^|\b)(si|sí|agendar_si|sí, agendar|si, agendar)/i.test(t)) {
      let slots = await this.getAvailableSlotsFromSheets(5, 21);
      if (!slots.length) {
        slots = this.buildFallbackSlots(7, ['09:00', '11:00', '15:00']);
      }

      let msg = `📅 *Horarios disponibles*\n\n`;
      slots.forEach((s, i) => (msg += `${i + 1}. ${s.label}\n`));
      msg += `\nResponde con el *número* (ej. 1) o escribe "*más*" para ver más opciones.`;

      const st = this.userStates.get(from) || { state: 'awaiting_appointment_confirmation' };
      st.lastOfferedSlots = slots;
      st.state = 'awaiting_slot_choice';
      st.currentStep = 2;
      st.updatedAt = Date.now();
      this.userStates.set(from, st);
      return msg;
    } else {
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      this.forms.delete(from);
      return 'De acuerdo. Si necesitas algo más escribe "hola". ¡Que tengas un buen día!';
    }
  }

  private buildFallbackSlots(days = 7, hours: string[] = ['09:00', '11:00', '15:00']): SlotOffered[] {
    const { y, m, day } = this.todayYMD();
    const base = new Date(Date.UTC(y, m - 1, day));
    const out: SlotOffered[] = [];
    for (let i = 0; i < days; i++) {
      const dt = new Date(base.getTime() + i * 24 * 60 * 60 * 1000);
      const yyyy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const fecha = `${yyyy}-${mm}-${dd}`;
      for (const h of hours) {
        out.push({ row: -1, date: fecha, time: h, label: `${fecha} a las ${h}`, fallback: true });
        if (out.length >= 10) break;
      }
      if (out.length >= 10) break;
    }
    return out;
  }

  private async handleMoreSlotsRequest(from: string): Promise<string> {
    const st = this.userStates.get(from);
    if (!st) return 'No tengo registro de tu solicitud. Por favor, escribe "hola" para comenzar.';

    const last = st.lastOfferedSlots || [];
    let additionalSlots: SlotOffered[] = [];

    if (last.some((s) => !s.fallback)) {
      const startIndex = last.length;
      const moreFromSheets = await this.getAvailableSlotsFromSheets(5, 21, startIndex);
      additionalSlots = moreFromSheets.length ? moreFromSheets : this.buildFallbackSlots(7, ['09:00', '11:00', '15:00']);
    } else {
      additionalSlots = this.buildFallbackSlots(7, ['09:00', '11:00', '15:00']);
    }

    if (!additionalSlots.length) return 'No hay más horarios disponibles en este momento. Elige entre las opciones anteriores o intenta más tarde.';

    const allSlots = [...last, ...additionalSlots];
    st.lastOfferedSlots = allSlots;
    this.userStates.set(from, st);

    let msg = `➕ *Más horarios disponibles:*\n\n`;
    additionalSlots.forEach((s, i) => {
      const num = i + 1 + (allSlots.length - additionalSlots.length);
      msg += `${num}. ${s.label}\n`;
    });
    msg += '\nResponde con el *número* que prefieras.';
    return msg;
  }

  private async handleSlotChoice(text: string, from: string): Promise<string> {
    const t = text.toLowerCase().trim();

    if (t === 'más' || t === 'mas' || t === 'more') return this.handleMoreSlotsRequest(from);

    const n = parseInt(t, 10);
    const st = this.userStates.get(from);

    if (!st || !Array.isArray(st.lastOfferedSlots) || !Number.isFinite(n) || n < 1 || n > st.lastOfferedSlots.length) {
      return 'Por favor, envía un número válido de la lista anterior (ej. 1) o escribe "más" para ver más opciones.';
    }

    const chosen = st.lastOfferedSlots[n - 1];

    if (!chosen.fallback) {
      const ok = await this.reserveSlotRow(chosen.row, from).catch(() => false);
      if (!ok) {
        await this.sendButtons(from, 'Ese horario acaba de ocuparse 😕. ¿Deseas ver otros horarios o que te contactemos?', [
          { type: 'reply', reply: { id: 'more_slots', title: 'Ver otros horarios' } },
          { type: 'reply', reply: { id: 'contact_me', title: 'Que me contacten' } },
        ]);
        return '';
      }
    }

    st.appointmentDate = chosen.date;
    st.appointmentTime = chosen.time;
    st.state = 'collecting_form';
    st.currentStep = 3;
    st.updatedAt = Date.now();
    this.userStates.set(from, st);

    this.startForm(from, st.serviceType || 'Servicio', [chosen]);
    await this.askNext(from);
    return '';
  }

  /* =========================
     Conversational Form Engine
     ========================= */
  private startForm(from: string, serviceType: string, slots: SlotOffered[]) {
    const autofilledPhone = this.onlyDigits(from);
    this.forms.set(from, { idx: 0, data: { telefono: autofilledPhone }, schema: this.FORM_APPT, serviceType, slots, autofilledPhone });
  }
  private async askNext(from: string) {
    const f = this.forms.get(from);
    if (!f) return;
    const field = f.schema[f.idx];
    await this.sendMessage(from, field.prompt({ autofilledPhone: f.autofilledPhone }));
  }
  private async handleFormInput(from: string, text: string): Promise<string> {
    const f = this.forms.get(from);
    if (!f) return '';

    const ntext = this.normalize(text);
    const field = f.schema[f.idx];
    let value = field.normalize ? field.normalize(text) : text;

    if (field.key === 'telefono' && ['si', 'sí', 'ok', 'confirmo'].includes(ntext)) value = f.autofilledPhone;

    const valid = field.validate(value);
    if (valid !== true) return String(valid);

    (f.data as any)[field.key] = String(value || '').trim();
    f.idx++;

    if (f.idx >= f.schema.length) {
      const resumen =
        `📋 *Revisa tu solicitud:*\n\n` +
        `🧾 *Servicio:* ${f.serviceType}\n` +
        `📅 *Fecha:* ${f.slots[0]?.date}\n` +
        `🕒 *Hora:* ${f.slots[0]?.time}\n\n` +
        `👤 *Nombre:* ${f.data.nombre}\n` +
        `📞 *Teléfono:* ${f.data.telefono}\n` +
        `✉️ *Email:* ${f.data.email || '—'}\n\n` +
        `¿Confirmas para guardar en agenda?`;
      await this.sendButtons(from, resumen, [
        { type: 'reply', reply: { id: 'confirm_yes', title: '✅ Confirmar' } },
        { type: 'reply', reply: { id: 'confirm_edit', title: '✏️ Editar' } },
      ]);
      return '';
    }

    await this.askNext(from);
    return '';
  }

  private async finalizeFormConfirmation(from: string): Promise<string> {
    const f = this.forms.get(from);
    const st = this.userStates.get(from);
    if (!f || !st) return 'No tengo registro de tu solicitud. Escribe "hola" para comenzar.';

    try {
      await this.appendAppointmentRow({
        telefono: f.data.telefono!,
        nombre: f.data.nombre!,
        email: f.data.email || '',
        servicio: f.serviceType || 'Sin especificar',
        fecha: f.slots[0].date,
        hora: f.slots[0].time,
        slotRow: f.slots[0].row,
      });
    } catch (e) {
      console.error('Error guardando cita en Sheets:', e);
      return 'Ocurrió un problema al guardar tu cita. Intenta nuevamente más tarde o llama al +591 65900645.';
    }

    const confirmadoMsg =
      `✅ *¡Cita confirmada!*\n\n` +
      `Gracias por agendar con *${COMPANY_NAME}*.\n` +
      `Te esperamos el ${f.slots[0].date} a las ${f.slots[0].time}.\n\n` +
      `Si necesitas cancelar o reprogramar, contáctanos al +591 65900645.`;
    await this.sendMessage(from, confirmadoMsg);

    try {
      const { buffer, filename } = await this.generateConfirmationPDFBuffer({
        clientData: f.data,
        serviceType: f.serviceType,
        appointmentDate: f.slots[0].date,
        appointmentTime: f.slots[0].time,
      });

      let sentOk = false;

      if (this.s3) {
        try {
          const url = await this.uploadToS3(buffer, filename, 'application/pdf');
          await this.sendDocumentByLink(from, url, filename, `Comprobante de cita - ${COMPANY_NAME}`);
          sentOk = true;
        } catch (e) {
          console.error('Fallo upload S3, usando Media API:', e);
        }
      }

      if (!sentOk) {
        const mediaId = await this.uploadMediaToWhatsApp(buffer, filename, 'application/pdf');
        await this.sendDocumentByMediaId(from, mediaId, filename, `Comprobante de cita - ${COMPANY_NAME}`);
      }
    } catch (e) {
      console.error('Error enviando PDF:', e);
    }

    this.forms.delete(from);
    this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
    return '¿Necesitas algo más? Escribe "hola" para volver al menú.';
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

  private async getAvailableSlotsFromSheets(max = 5, daysAhead = 21, startIndex = 0): Promise<SlotOffered[]> {
    const { y, m, day } = this.todayYMD();
    const today = new Date(Date.UTC(y, m - 1, day));
    const until = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const r: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({ spreadsheetId: this.SPREADSHEET_ID, range: `${this.TAB_SLOTS}!A2:E` })
    );

    const rows: string[][] = r.data.values || [];
    const out: SlotOffered[] = [];

    for (let i = startIndex; i < rows.length; i++) {
      const rowIdx = i + 2;
      const fechaRaw = rows[i][0] || '';
      const hora = rows[i][1] || '';
      const estadoRaw = (rows[i][2] || '').toString();

      // Estado válido: vacío o "disponible"
      if (estadoRaw && !/disponible/i.test(estadoRaw)) continue;

      const parsed = this.parseFlexibleDate(fechaRaw);
      if (!parsed) continue;
      const dt = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.day));
      if (dt < today || dt > until) continue;

      const fechaYMD = `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
      const label = `${fechaYMD} a las ${hora}`;
      out.push({ row: rowIdx, date: fechaYMD, time: hora, label });

      if (out.length >= max) break;
    }
    return out;
  }

  private async reserveSlotRow(rowNumber: number, byPhone: string): Promise<boolean> {
    if (rowNumber <= 0) return true; // fallback
    const stateRange = `${this.TAB_SLOTS}!C${rowNumber}:E${rowNumber}`;

    const read: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({ spreadsheetId: this.SPREADSHEET_ID, range: stateRange })
    );

    const cur = (read.data.values && read.data.values[0]) || [];
    const currentState = ((cur[0] || '') + '').toUpperCase();

    if (currentState && currentState !== 'DISPONIBLE') return false;

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
      '',
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
     PDF con QR (Buffer)
     ========================= */
  private async generateConfirmationPDFBuffer(state: any): Promise<{ buffer: Buffer; filename: string }> {
    const safeName = (state.clientData?.nombre || 'Cliente').replace(/\s+/g, '_');
    const filename = `cita_${safeName}_${Date.now()}.pdf`;

    return await new Promise((resolve, reject) => {
      const doc = new (PDFDocument as any)({ margin: 40 });
      const chunks: Buffer[] = [];

      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename }));
      doc.on('error', reject);

      try {
        const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
        if (fs.existsSync(logoPath)) doc.image(logoPath, { width: 120 });
      } catch {}

      doc.moveDown(1);
      doc.fontSize(18).text(COMPANY_NAME, { align: 'center', underline: true });
      doc.moveDown(0.2);
      doc.fontSize(16).text('Confirmación de Cita', { align: 'center' });
      doc.moveDown(1);

      doc.fontSize(12);
      doc.text(`Nombre: ${state.clientData?.nombre || ''}`);
      doc.text(`Teléfono: ${state.clientData?.telefono || ''}`);
      doc.text(`Email: ${state.clientData?.email || ''}`);
      doc.moveDown(0.5);
      doc.text(`Servicio: ${state.serviceType || ''}`);
      doc.text(`Fecha: ${state.appointmentDate || ''}`);
      doc.text(`Hora: ${state.appointmentTime || ''}`);
      doc.moveDown(1);

      (async () => {
        try {
          const qrText = JSON.stringify({
            empresa: COMPANY_NAME,
            nombre: state.clientData?.nombre,
            telefono: state.clientData?.telefono,
            email: state.clientData?.email,
            fecha: state.appointmentDate,
            hora: state.appointmentTime,
            servicio: state.serviceType,
          });
          const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', errorCorrectionLevel: 'M' });
          doc.image(qrBuffer, doc.page.width - 150, doc.y, { width: 100 });
        } catch {}
        doc.moveDown(3);

        doc.text('Por favor:', { underline: true });
        doc.text('• Presentarse 5 minutos antes de la cita');
        doc.text('• Traer documentación relevante');
        doc.text('• Contactarnos al +591 65900645 en caso de inconvenientes');
        doc.moveDown(1);

        doc.text(`ID de reserva: ${Date.now()}`, { oblique: true });
        doc.end();
      })();
    });
  }

  private async uploadToS3(buffer: Buffer, filename: string, contentType = 'application/pdf'): Promise<string> {
    if (!this.s3) throw new Error('S3 no configurado.');
    const Bucket = process.env.AWS_S3_BUCKET!;
    await this.s3.send(
      new PutObjectCommand({
        Bucket,
        Key: `citas/${filename}`,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      })
    );
    return `https://${Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/citas/${filename}`;
  }
}
